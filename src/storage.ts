// Verileri şimdilik tarayıcının kendi hafızasında (localStorage) tutuyoruz.
// Arkadaşlar kısmına geçince bu dosyanın yerini Supabase alacak;
// uygulamanın geri kalanı sadece bu fonksiyonları kullandığı için değişmeyecek.

import { DEFAULT_SETTINGS, type Session, type Settings } from "./types";

const SESSIONS_KEY = "gazzla.sessions";
const SETTINGS_KEY = "gazzla.settings";

export function loadSessions(): Session[] {
  const raw = localStorage.getItem(SESSIONS_KEY);
  return raw ? (JSON.parse(raw) as Session[]) : [];
}

export function addSession(session: Session): void {
  const all = loadSessions();
  all.push(session);
  saveSessions(all);
  markPending([session.id]); // hesaba yüklenecekler listesine ekle
}

/** Tüm kayıt listesini yazar (eşitleme sırasında buluttan gelenlerle birleştirilmiş liste). */
export function saveSessions(sessions: Session[]): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

// ---------- Eşitleme (bulut) için yardımcılar ----------
// "Bekleyenler": bu cihazda eklenmiş ya da değişmiş ama henüz Supabase'e yüklenmemiş kayıtların kimlikleri.
// İnternet yokken de seans kaydedebilmek için önce buraya yazıyoruz, bağlantı olunca yükleniyor.

const PENDING_KEY = "gazzla.pendingSync";
const SYNC_OWNER_KEY = "gazzla.syncOwner"; // bu cihazdaki kayıtların hangi hesaba ait olduğu

export function loadPending(): string[] {
  const raw = localStorage.getItem(PENDING_KEY);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

export function markPending(ids: string[]): void {
  const set = new Set(loadPending());
  ids.forEach((id) => set.add(id));
  localStorage.setItem(PENDING_KEY, JSON.stringify([...set]));
}

/** Yüklenen kimlikleri bekleyenlerden çıkarır (yükleme sırasında yeni eklenenler kalır). */
export function clearPending(ids: string[]): void {
  const done = new Set(ids);
  localStorage.setItem(PENDING_KEY, JSON.stringify(loadPending().filter((id) => !done.has(id))));
}

export function loadSyncOwner(): string | null {
  return localStorage.getItem(SYNC_OWNER_KEY);
}

export function saveSyncOwner(userId: string): void {
  localStorage.setItem(SYNC_OWNER_KEY, userId);
}

export function loadSettings(): Settings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  // Kayıtlı ayar yoksa varsayılanları kullan; eksik alan varsa varsayılanla doldur.
  return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** Bir tarihi "2026-11-26" gibi gün anahtarına çevirir (yerel saate göre). */
export function dayKey(time: number | Date): string {
  const d = new Date(time);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Her gün için toplam çalışma dakikası: { "2026-11-26": 135, ... }
 * subject verilirse sadece o dersin seansları sayılır.
 */
export function workMinutesByDay(subject?: string): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const s of loadSessions()) {
    if (s.kind !== "work") continue;
    if (subject !== undefined && s.subject !== subject) continue;
    const key = dayKey(s.startedAt);
    byDay.set(key, (byDay.get(key) ?? 0) + s.durationMs / 60000);
  }
  return byDay;
}

/** Bugün yapılan toplam çalışma süresi (dakika). */
export function todayWorkMinutes(): number {
  return Math.round(workMinutesByDay().get(dayKey(new Date())) ?? 0);
}

/**
 * Seri: kaç gündür üst üste günlük hedef tutturuldu.
 * Bugün hedef henüz tutmadıysa seri bozulmuş sayılmaz; dünden geriye sayılır.
 */
export function currentStreak(goalMin: number): number {
  const byDay = workMinutesByDay();
  const met = (d: Date) => (byDay.get(dayKey(d)) ?? 0) >= goalMin;

  const day = new Date();
  if (!met(day)) day.setDate(day.getDate() - 1);

  let streak = 0;
  while (met(day)) {
    streak++;
    day.setDate(day.getDate() - 1);
  }
  return streak;
}

/** Daha önce kullanılmış dersler, en son kullanılan en başta. */
export function knownSubjects(): string[] {
  const seen = new Set<string>();
  const sessions = loadSessions();
  for (let i = sessions.length - 1; i >= 0; i--) {
    const subject = sessions[i].subject;
    if (subject) seen.add(subject);
  }
  return [...seen];
}

export interface SubjectStats {
  subject: string; // "Genel çalışma" = ders seçilmemiş
  todayMin: number;
  weekMin: number;
  totalMin: number;
}

export const GENERAL = "Genel çalışma";

/** Bu haftanın pazartesi 00:00'ı. */
export function startOfWeek(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const daysSinceMonday = (d.getDay() + 6) % 7; // getDay(): pazar=0, pazartesi=1
  d.setDate(d.getDate() - daysSinceMonday);
  return d;
}

/**
 * Bu hafta (pazartesiden beri) yapılan toplam çalışma süresi (dakika, küsuratlı).
 * subject verilirse sadece o ders.
 */
export function weekWorkMinutes(subject?: string): number {
  const week = startOfWeek().getTime();
  return loadSessions()
    .filter((s) => s.kind === "work" && s.startedAt >= week)
    .filter((s) => subject === undefined || s.subject === subject)
    .reduce((sum, s) => sum + s.durationMs / 60000, 0);
}

/** Ders bazında bugün / bu hafta / toplam çalışma dakikaları. */
export function statsBySubject(): SubjectStats[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week = startOfWeek().getTime();
  const map = new Map<string, SubjectStats>();

  for (const s of loadSessions()) {
    if (s.kind !== "work") continue;
    const name = s.subject ?? GENERAL;
    const row = map.get(name) ?? { subject: name, todayMin: 0, weekMin: 0, totalMin: 0 };
    const min = s.durationMs / 60000;
    row.totalMin += min;
    if (s.startedAt >= week) row.weekMin += min;
    if (s.startedAt >= today.getTime()) row.todayMin += min;
    map.set(name, row);
  }
  return [...map.values()].sort((a, b) => b.totalMin - a.totalMin);
}

/** Bu hafta çalışma seanslarında toplam kaç kez duraklatıldı. */
export function weekPauseCount(): number {
  const week = startOfWeek().getTime();
  return loadSessions()
    .filter((s) => s.kind === "work" && s.startedAt >= week)
    .reduce((sum, s) => sum + (s.pauseCount ?? 0), 0);
}

/** Son 7 günün her biri için çalışma dakikası (eskiden yeniye). subject verilirse sadece o ders. */
export function lastSevenDays(subject?: string): { label: string; minutes: number }[] {
  const byDay = workMinutesByDay(subject);
  const names = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    result.push({ label: i === 0 ? "Bugün" : names[d.getDay()], minutes: byDay.get(dayKey(d)) ?? 0 });
  }
  return result;
}

// ---------- Ders listesi ----------
// Dersler artık ayrı bir listede tutuluyor (Dersler ekranından yönetiliyor).

const SUBJECTS_KEY = "gazzla.subjects";

export function loadSubjects(): string[] {
  const raw = localStorage.getItem(SUBJECTS_KEY);
  // İlk açılışta liste yoksa, eski seanslarda kullanılan derslerden oluştur.
  return raw ? (JSON.parse(raw) as string[]) : knownSubjects();
}

function saveSubjects(subjects: string[]): void {
  localStorage.setItem(SUBJECTS_KEY, JSON.stringify(subjects));
}

/** Yeni ders ekler. Aynı isim zaten varsa false döner. */
export function addSubject(name: string): boolean {
  const list = loadSubjects();
  if (list.some((s) => s.toLowerCase() === name.toLowerCase())) return false;
  list.push(name);
  saveSubjects(list);
  return true;
}

/** Dersi listeden kaldırır. Geçmiş kayıtlar ve istatistikler silinmez; dersin hedefi silinir. */
export function removeSubject(name: string): void {
  saveSubjects(loadSubjects().filter((s) => s !== name));
  setSubjectGoal(name, undefined);
}

/** Dersin adını değiştirir; geçmiş seanslar da yeni adla güncellenir. */
export function renameSubject(oldName: string, newName: string): boolean {
  const list = loadSubjects();
  if (list.some((s) => s !== oldName && s.toLowerCase() === newName.toLowerCase())) return false;
  saveSubjects(list.map((s) => (s === oldName ? newName : s)));
  // Hedefi de yeni ada taşı.
  const goal = loadSubjectGoals()[oldName];
  if (goal !== undefined) {
    setSubjectGoal(oldName, undefined);
    setSubjectGoal(newName, goal);
  }
  const changed: string[] = [];
  const sessions = loadSessions().map((s) => {
    if (s.subject !== oldName) return s;
    changed.push(s.id);
    return { ...s, subject: newName };
  });
  saveSessions(sessions);
  markPending(changed); // değişen kayıtlar buluta da yeniden yüklensin
  return true;
}

// ---------- Ders hedefleri ----------
// Her ders için isteğe bağlı haftalık hedef (dakika). Hedefi olmayan ders burada hiç geçmez.
// Kayıt şekli: { "Analysis I": 300, "Informatik II": 240 }
// C++'taki std::map<std::string, int> gibi; JSON'a doğrudan yazılabildiği için düz nesne kullanıyoruz.

const SUBJECT_GOALS_KEY = "gazzla.subjectGoals";

export function loadSubjectGoals(): Record<string, number> {
  const raw = localStorage.getItem(SUBJECT_GOALS_KEY);
  return raw ? (JSON.parse(raw) as Record<string, number>) : {};
}

/** Dersin haftalık hedefi (dakika) ya da hedef yoksa undefined. */
export function subjectGoal(name: string): number | undefined {
  return loadSubjectGoals()[name];
}

/** minutes = undefined verilirse dersin hedefi kaldırılır. */
export function setSubjectGoal(name: string, minutes: number | undefined): void {
  const goals = loadSubjectGoals();
  if (minutes === undefined) delete goals[name];
  else goals[name] = minutes;
  localStorage.setItem(SUBJECT_GOALS_KEY, JSON.stringify(goals));
}
