// Çalışma kayıtlarını ve proje listesini (hedefleriyle) Supabase ile eşitleme.
//
// Fikir: Kayıtların asıl yeri yine bu cihaz (localStorage); uygulama internetsiz de çalışır.
// Giriş yapılmışsa sync() iki iş yapar:
//   1) Yükle: "bekleyen" (henüz yüklenmemiş) kayıtları Supabase'e gönder.
//   2) İndir: hesaptaki tüm kayıtları al, bu cihazdakilerle birleştir
//      (böylece telefonda yaptığın seans bilgisayarda da görünür).
//
// C++ benzetmesi: localStorage bir önbellek (cache), Supabase de asıl depo;
// sync() ikisini tutarlı hale getiren fonksiyon.

import { supabase } from "./supabase";
import {
  clearPending,
  clearPendingProjects,
  loadPending,
  loadPendingProjects,
  loadProjectsOwner,
  loadSessions,
  loadSubjectGoals,
  loadSubjects,
  loadSyncOwner,
  markPending,
  markPendingProjects,
  replaceProjects,
  saveProjectsOwner,
  saveSessions,
  saveSyncOwner,
} from "./storage";
import type { Session } from "./types";
import {
  clearPendingBlocks,
  loadAllBlocks,
  loadPendingBlocks,
  loadTimetableOwner,
  markPendingBlocks,
  saveAllBlocks,
  saveTimetableOwner,
  type Block,
} from "./timetable";

/** Veritabanındaki bir satırın şekli (sütun adları SQL'deki gibi). */
interface SessionRow {
  id: string;
  user_id: string;
  kind: "work" | "break";
  started_at: string; // ISO tarih metni, ör. "2026-11-26T18:30:00.000Z"
  duration_ms: number;
  subject: string | null;
  pause_count: number | null;
}

function toRow(s: Session, userId: string): SessionRow {
  return {
    id: s.id,
    user_id: userId,
    kind: s.kind,
    started_at: new Date(s.startedAt).toISOString(),
    duration_ms: Math.round(s.durationMs),
    subject: s.subject ?? null,
    pause_count: s.pauseCount ?? null,
  };
}

function fromRow(r: SessionRow): Session {
  return {
    id: r.id,
    kind: r.kind,
    startedAt: Date.parse(r.started_at),
    durationMs: r.duration_ms,
    subject: r.subject ?? undefined,
    pauseCount: r.pause_count ?? undefined,
  };
}

export interface SyncResult {
  ok: boolean;
  changed: boolean; // bu cihazdaki kayıtlar değişti mi (ekranı yenilemek gerekir mi)
  error?: string;
}

let running: Promise<SyncResult> | undefined; // aynı anda iki eşitleme çalışmasın

export function sync(userId: string): Promise<SyncResult> {
  // Zaten çalışıyorsa, bitince bir tur daha çalıştır (arada yeni seans eklenmiş olabilir).
  if (running) return running.then(() => sync(userId));
  running = doSync(userId).finally(() => (running = undefined));
  return running;
}

const snapshot = () =>
  JSON.stringify([
    [...loadSessions()].sort((a, b) => a.startedAt - b.startedAt),
    loadSubjects(),
    loadSubjectGoals(),
    [...loadAllBlocks()].sort((a, b) => a.id.localeCompare(b.id)),
  ]);

async function doSync(userId: string): Promise<SyncResult> {
  const before = snapshot(); // sonda "bir şey değişti mi?" diye karşılaştırmak için

  // --- Bu cihazdaki kayıtlar kimin? ---
  const owner = loadSyncOwner();
  if (owner === null) {
    // İlk kez giriş yapılıyor: giriş öncesi yaptığın tüm seanslar bu hesaba yüklensin.
    markPending(loadSessions().map((s) => s.id));
    saveSyncOwner(userId);
  } else if (owner !== userId) {
    // Bu cihazda daha önce BAŞKA bir hesapla giriş yapılmış.
    if (loadPending().length > 0 || loadPendingProjects().length > 0 || loadPendingBlocks().length > 0) {
      // Önceki hesabın yüklenmemiş kayıtları var: onları silmeyelim, yeni hesaba da karıştırmayalım.
      return {
        ok: false,
        changed: false,
        error: "Bu cihazda önceki hesabın yüklenmemiş kayıtları var. Önce o hesapla giriş yapıp eşitle.",
      };
    }
    // Önceki hesabın her şeyi zaten bulutta; bu cihazı yeni hesap için boşalt.
    saveSessions([]);
    replaceProjects([], {});
    saveAllBlocks([]);
    saveSyncOwner(userId);
    saveProjectsOwner(userId);
    saveTimetableOwner(userId);
  }

  // Projeler bu hesapla hiç eşitlenmediyse (ilk giriş ya da bu özellikten önce giriş yapılmış cihaz):
  // bu cihazdaki tüm projeler ve hedefleri hesaba yüklensin.
  if (loadProjectsOwner() !== userId) {
    markPendingProjects(loadSubjects());
    saveProjectsOwner(userId);
  }
  // Program için de aynısı (program bu hesapla hiç eşitlenmediyse tüm bloklar yüklensin).
  if (loadTimetableOwner() !== userId) {
    markPendingBlocks(loadAllBlocks().map((b) => b.id));
    saveTimetableOwner(userId);
  }

  // --- 1) Yükle ---
  const pending = loadPending();
  if (pending.length > 0) {
    const pendingSet = new Set(pending);
    const rows = loadSessions()
      .filter((s) => pendingSet.has(s.id))
      .map((s) => toRow(s, userId));
    // upsert = "yoksa ekle, varsa güncelle" (id'ye göre).
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("sessions").upsert(rows.slice(i, i + 500));
      if (error) return { ok: false, changed: false, error: explain(error) };
    }
    clearPending(pending);
  }

  // --- 2) İndir --- (Supabase bir istekte en fazla 1000 satır verir, o yüzden sayfa sayfa)
  const remote: Session[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("sessions")
      .select("id, user_id, kind, started_at, duration_ms, subject, pause_count")
      .eq("user_id", userId)
      .order("started_at")
      .range(from, from + 999);
    if (error) return { ok: false, changed: false, error: explain(error) };
    const rows = (data ?? []) as SessionRow[];
    remote.push(...rows.map(fromRow));
    if (rows.length < 1000) break;
  }

  // --- Birleştir ---
  // Buluttaki hali esas; ama bu sırada yeni eklenmiş (hâlâ bekleyen) yerel kayıtlar korunur.
  const stillPending = new Set(loadPending());
  const merged = new Map<string, Session>();
  for (const s of remote) merged.set(s.id, s);
  for (const s of loadSessions()) {
    if (stillPending.has(s.id) || !merged.has(s.id)) merged.set(s.id, s);
  }
  const result = [...merged.values()].sort((a, b) => a.startedAt - b.startedAt);

  saveSessions(result);

  // --- 3) Projeler ---
  const projectError = await syncProjects(userId);
  if (projectError) return { ok: false, changed: before !== snapshot(), error: projectError };

  // --- 4) Program ---
  const timetableError = await syncTimetable(userId);
  if (timetableError) return { ok: false, changed: before !== snapshot(), error: timetableError };

  return { ok: true, changed: before !== snapshot() };
}

// ---------- Projeler ----------
// Seanslarla aynı fikir: önce bekleyenleri yükle, sonra hesaptakini indirip birleştir.
// Fark: proje "silinince" satır silinmez, deleted = true yazılır (öbür cihaz da öğrensin diye).

interface ProjectRow {
  user_id: string;
  name: string;
  weekly_goal_min: number | null;
  position: number;
  deleted: boolean;
}

/** Projeleri eşitler. Sorun olursa hata mesajını, yoksa undefined döner. */
async function syncProjects(userId: string): Promise<string | undefined> {
  // --- Yükle ---
  const pending = loadPendingProjects();
  if (pending.length > 0) {
    const list = loadSubjects();
    const goals = loadSubjectGoals();
    const rows: ProjectRow[] = pending.map((name) => {
      const index = list.indexOf(name);
      return {
        user_id: userId,
        name,
        weekly_goal_min: index >= 0 ? (goals[name] ?? null) : null,
        position: Math.max(index, 0),
        deleted: index < 0, // listede yoksa bu cihazda silinmiş (ya da adı değişmiş)
      };
    });
    const { error } = await supabase.from("projects").upsert(rows, { onConflict: "user_id,name" });
    if (error) return explain(error, "projects");
    clearPendingProjects(pending);
  }

  // --- İndir ---
  const remote: ProjectRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("projects")
      .select("user_id, name, weekly_goal_min, position, deleted")
      .eq("user_id", userId)
      .order("position")
      .order("name")
      .range(from, from + 999);
    if (error) return explain(error, "projects");
    const rows = (data ?? []) as ProjectRow[];
    remote.push(...rows);
    if (rows.length < 1000) break;
  }

  // --- Birleştir ---
  // Buluttaki hali esas; ama bu sırada değişmiş (hâlâ bekleyen) projelerde bu cihazdaki hal korunur.
  const stillPending = new Set(loadPendingProjects());
  const localList = loadSubjects();
  const localGoals = loadSubjectGoals();

  const list: string[] = [];
  const goals: Record<string, number> = {};
  for (const r of remote) {
    if (r.deleted || stillPending.has(r.name)) continue;
    list.push(r.name);
    if (r.weekly_goal_min !== null) goals[r.name] = r.weekly_goal_min;
  }
  localList.forEach((name, index) => {
    if (!stillPending.has(name)) return;
    list.splice(Math.min(index, list.length), 0, name); // bu cihazdaki sırasına yerleştir
    if (localGoals[name] !== undefined) goals[name] = localGoals[name];
  });

  replaceProjects(list, goals);
  return undefined;
}

// ---------- Program (ders programı) ----------
// Seanslarla aynı: bekleyen blokları yükle, sonra hepsini indirip birleştir.
// Silinen blok deleted = true olarak kalır (öbür cihaz da silindiğini öğrensin).

interface BlockRow {
  id: string;
  user_id: string;
  kind: "study" | "fixed";
  subject: string | null;
  title: string | null;
  weekday: number | null;
  date: string | null; // "2026-12-03"
  start_min: number;
  end_min: number;
  deleted: boolean;
  updated_at?: string;
}

function blockToRow(b: Block, userId: string): BlockRow {
  return {
    id: b.id,
    user_id: userId,
    kind: b.kind,
    subject: b.subject ?? null,
    title: b.title ?? null,
    weekday: b.weekday ?? null,
    date: b.date ?? null,
    start_min: b.start,
    end_min: b.end,
    deleted: b.deleted ?? false,
  };
}

function blockFromRow(r: BlockRow): Block {
  return {
    id: r.id,
    kind: r.kind,
    subject: r.subject ?? undefined,
    title: r.title ?? undefined,
    weekday: r.weekday ?? undefined,
    date: r.date ?? undefined,
    start: r.start_min,
    end: r.end_min,
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : 0,
    deleted: r.deleted || undefined,
  };
}

async function syncTimetable(userId: string): Promise<string | undefined> {
  // --- Yükle ---
  const pending = loadPendingBlocks();
  if (pending.length > 0) {
    const pendingSet = new Set(pending);
    const rows = loadAllBlocks()
      .filter((b) => pendingSet.has(b.id))
      .map((b) => blockToRow(b, userId));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("timetable_blocks").upsert(rows.slice(i, i + 500));
      if (error) return explain(error, "timetable_blocks");
    }
    clearPendingBlocks(pending);
  }

  // --- İndir ---
  const remote: Block[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("timetable_blocks")
      .select("id, user_id, kind, subject, title, weekday, date, start_min, end_min, deleted, updated_at")
      .eq("user_id", userId)
      .order("id")
      .range(from, from + 999);
    if (error) return explain(error, "timetable_blocks");
    const rows = (data ?? []) as BlockRow[];
    remote.push(...rows.map(blockFromRow));
    if (rows.length < 1000) break;
  }

  // --- Birleştir --- (buluttaki esas; bu sırada değişmiş, hâlâ bekleyen bloklarda bu cihazdaki hal)
  const stillPending = new Set(loadPendingBlocks());
  const merged = new Map<string, Block>();
  for (const b of remote) merged.set(b.id, b);
  for (const b of loadAllBlocks()) {
    if (stillPending.has(b.id) || !merged.has(b.id)) merged.set(b.id, b);
  }
  saveAllBlocks([...merged.values()]);
  return undefined;
}

function explain(error: { code?: string; message: string }, table = "sessions"): string {
  if (error.code === "PGRST205" || error.code === "42P01")
    return `Supabase'de '${table}' tablosu yok. SQL'i SQL Editor'de çalıştırdın mı?`;
  if (error.message.toLowerCase().includes("failed to fetch")) return "İnternete bağlanılamadı, sonra tekrar denenecek.";
  return error.message;
}
