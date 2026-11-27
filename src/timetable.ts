// Haftalık program (ders programı / timetable): veriler ve hesaplar.
//
// Programda "blok"lar var. Bir blok ya
//   - "study": çalışma bloğu, bir Gazzla projesine bağlı (subject yoksa "Genel çalışma"), ya da
//   - "fixed": sabit blok (ders, alıştırma saati, etkinlik); çalışma süresine sayılmaz.
// Blok ya her hafta tekrar eder (weekday dolu), ya da tek bir tarihte olur (date dolu).
//
// Seanslar gibi önce bu cihazda (localStorage) tutulur, giriş yapılmışsa sync.ts buluta eşitler.
// Silinen blok listeden çıkarılmaz, deleted = true olur (öbür cihaz da "silindi" diye öğrensin).

import { dayKey, startOfWeek } from "./storage";

export interface Block {
  id: string;
  kind: "study" | "fixed";
  subject?: string; // study: proje adı (yoksa genel çalışma)
  title?: string; // fixed: "Lineare Algebra dersi" gibi
  weekday?: number; // her hafta tekrar eden blok: 0 = pazartesi ... 6 = pazar
  date?: string; // tek seferlik blok: "2026-12-03"
  start: number; // gece yarısından beri dakika (09:30 = 570)
  end: number; // bitiş, start'tan büyük (en fazla 1440 = 24:00)
  updatedAt: number;
  deleted?: boolean;
}

const BLOCKS_KEY = "gazzla.timetable";
const PENDING_KEY = "gazzla.pendingTimetable";
const OWNER_KEY = "gazzla.timetableSyncOwner";

export const DAY_NAMES = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
export const DAY_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

// ---------- Kaydetme ----------

/** Tüm bloklar, silinmişler dahil (eşitleme için). Ekranda kullanmak için activeBlocks(). */
export function loadAllBlocks(): Block[] {
  try {
    const raw = localStorage.getItem(BLOCKS_KEY);
    return raw ? (JSON.parse(raw) as Block[]) : [];
  } catch {
    return [];
  }
}

export function saveAllBlocks(blocks: Block[]): void {
  localStorage.setItem(BLOCKS_KEY, JSON.stringify(blocks));
}

export function activeBlocks(): Block[] {
  return loadAllBlocks().filter((b) => !b.deleted);
}

/** Bloğu ekler ya da (aynı id varsa) günceller. */
export function putBlock(block: Block): void {
  const all = loadAllBlocks().filter((b) => b.id !== block.id);
  all.push({ ...block, updatedAt: Date.now() });
  saveAllBlocks(all);
  markPendingBlocks([block.id]);
}

export function deleteBlock(id: string): void {
  const all = loadAllBlocks().map((b) => (b.id === id ? { ...b, deleted: true, updatedAt: Date.now() } : b));
  saveAllBlocks(all);
  markPendingBlocks([id]);
}

/** Proje adı değişince o projenin blokları da yeni adı alsın. */
export function renameBlocksSubject(oldName: string, newName: string): void {
  const changed: string[] = [];
  const all = loadAllBlocks().map((b) => {
    if (b.subject !== oldName) return b;
    changed.push(b.id);
    return { ...b, subject: newName, updatedAt: Date.now() };
  });
  saveAllBlocks(all);
  markPendingBlocks(changed);
}

// ---------- Bekleyenler (henüz buluta yüklenmemiş bloklar) ----------

export function loadPendingBlocks(): string[] {
  const raw = localStorage.getItem(PENDING_KEY);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

export function markPendingBlocks(ids: string[]): void {
  const set = new Set(loadPendingBlocks());
  ids.forEach((id) => set.add(id));
  localStorage.setItem(PENDING_KEY, JSON.stringify([...set]));
}

export function clearPendingBlocks(ids: string[]): void {
  const done = new Set(ids);
  localStorage.setItem(PENDING_KEY, JSON.stringify(loadPendingBlocks().filter((id) => !done.has(id))));
}

export function loadTimetableOwner(): string | null {
  return localStorage.getItem(OWNER_KEY);
}

export function saveTimetableOwner(userId: string): void {
  localStorage.setItem(OWNER_KEY, userId);
}

// ---------- Hesaplar ----------

/** 0 = pazartesi ... 6 = pazar (JavaScript'in getDay()'i pazarı 0 sayıyor, onu kaydırıyoruz). */
export function weekdayOf(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** weekOffset hafta sonraki (eksi = önceki) haftanın pazartesisi, 00:00. */
export function mondayOf(weekOffset: number): Date {
  const d = startOfWeek();
  d.setDate(d.getDate() + weekOffset * 7);
  return d;
}

/** Bu blok verilen günde var mı? */
export function occursOn(b: Block, day: Date): boolean {
  if (b.deleted) return false;
  return b.date !== undefined ? b.date === dayKey(day) : b.weekday === weekdayOf(day);
}

/** O günün blokları, başlangıç saatine göre sıralı. */
export function blocksOn(day: Date, blocks = activeBlocks()): Block[] {
  return blocks.filter((b) => occursOn(b, day)).sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Bloğun ekranda görünen adı. */
export function blockLabel(b: Block, general: string): string {
  return b.kind === "fixed" ? (b.title ?? "Etkinlik") : (b.subject ?? general);
}

/**
 * Haftanın planlanan çalışma süreleri (dakika), projeye göre. Anahtar: proje adı ya da general.
 * C++'taki std::map<std::string, int> gibi.
 */
export function plannedByProject(weekOffset: number, general: string): Map<string, number> {
  const monday = mondayOf(weekOffset);
  const blocks = activeBlocks().filter((b) => b.kind === "study");
  const result = new Map<string, number>();
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    for (const b of blocksOn(day, blocks)) {
      const key = b.subject ?? general;
      result.set(key, (result.get(key) ?? 0) + (b.end - b.start));
    }
  }
  return result;
}

/** Şu an süren çalışma bloğu; yoksa en geç `soonMin` dakika içinde başlayacak olan. */
export function currentStudyBlock(now = new Date(), soonMin = 15): { block: Block; startsIn: number } | undefined {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = blocksOn(now).filter((b) => b.kind === "study");
  const running = today.find((b) => b.start <= nowMin && nowMin < b.end);
  if (running) return { block: running, startsIn: 0 };
  const next = today.find((b) => b.start > nowMin && b.start - nowMin <= soonMin);
  return next ? { block: next, startsIn: next.start - nowMin } : undefined;
}

/**
 * Bir günün kutularını yan yana dizer: çakışanlar aynı "küme"de, her biri bir "şerit"te.
 * Dönen lane = kaçıncı şerit, lanes = o kümede kaç şerit var (genişlik = 1 / lanes).
 * T: start/end'i olan her şey (Gazzla bloğu ya da Google etkinliği). C++'taki template gibi.
 */
export function layoutDay<T extends { start: number; end: number }>(items: T[]): { item: T; lane: number; lanes: number }[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { item: T; lane: number; lanes: number }[] = [];
  let cluster: { item: T; lane: number; lanes: number }[] = [];
  let laneEnds: number[] = []; // her şeridin en son bittiği dakika
  let clusterEnd = -1;

  const flush = () => {
    cluster.forEach((c) => (c.lanes = laneEnds.length));
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };

  for (const it of sorted) {
    if (it.start >= clusterEnd) flush(); // önceki kümeyle çakışmıyor: yeni küme
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else laneEnds[lane] = it.end;
    cluster.push({ item: it, lane, lanes: 0 });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}
