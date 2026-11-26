// Çalışma kayıtlarını Supabase ile eşitleme.
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
  loadPending,
  loadSessions,
  loadSyncOwner,
  saveSessions,
  saveSyncOwner,
  markPending,
} from "./storage";
import type { Session } from "./types";

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

const snapshot = () => JSON.stringify([...loadSessions()].sort((a, b) => a.startedAt - b.startedAt));

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
    if (loadPending().length > 0) {
      // Önceki hesabın yüklenmemiş kayıtları var: onları silmeyelim, yeni hesaba da karıştırmayalım.
      return {
        ok: false,
        changed: false,
        error: "Bu cihazda önceki hesabın yüklenmemiş kayıtları var. Önce o hesapla giriş yapıp eşitle.",
      };
    }
    // Önceki hesabın her şeyi zaten bulutta; bu cihazı yeni hesap için boşalt.
    saveSessions([]);
    saveSyncOwner(userId);
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
  return { ok: true, changed: before !== snapshot() };
}

function explain(error: { code?: string; message: string }): string {
  if (error.code === "PGRST205" || error.code === "42P01")
    return "Supabase'de 'sessions' tablosu yok. SQL'i SQL Editor'de çalıştırdın mı?";
  if (error.message.toLowerCase().includes("failed to fetch")) return "İnternete bağlanılamadı, sonra tekrar denenecek.";
  return error.message;
}
