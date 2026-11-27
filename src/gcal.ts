// Google Calendar bağlantısı (iki yönlü).
//
// Kullanıcı bir kez "Google Calendar'ı bağla" der ve Google'da izin verir. Sonrası kendiliğinden:
//   - Gazzla → Google: programdaki her blok, Google'da ayrı bir "Gazzla" takviminde bir etkinlik olur.
//     Her hafta tekrar eden blok = tekrarlayan etkinlik. Blok değişince/silinince etkinlik de değişir.
//   - Google → Gazzla: "Gazzla" takviminde sürüklenen/yeniden adlandırılan/silinen etkinlik bloğa yansır.
//     Kullanıcı Google'da "Gazzla" takvimine yeni etkinlik eklerse programa blok olarak gelir.
//   - Google'daki öbür takvimler (ders programı, kişisel takvim...) sadece OKUNUR ve programda
//     olduğu gibi gösterilir. Gazzla onları projeye çevirmeye ya da değiştirmeye kalkmaz.
//     (Adı bir projeyle aynıysa o projenin planı sayılır, o kadar.)
//
// Anahtarlar: Google'ın uzun ömürlü anahtarı sunucuda (Supabase "gcal-auth" fonksiyonu) durur;
// tarayıcı oradan 1 saatlik erişim anahtarı alır. Bu yüzden Google bağlantısı için Gazzla girişi gerekir.

import { supabase } from "./supabase";
import { dayKey, GENERAL, loadSubjects } from "./storage";
import { loadAllBlocks, mondayOf, putBlock, deleteBlock, weekdayOf, type Block } from "./timetable";
import { clockText } from "./util";

/**
 * Google Cloud Console'da oluşturulan "OAuth istemci kimliği" (Web uygulaması).
 * Gizli değil: tarayıcıda zaten görünür. Gizli olan "client secret" sunucuda (Supabase Secrets).
 * Boşsa Google bölümü hiç gösterilmez.
 */
export const GOOGLE_CLIENT_ID: string = "338053954914-m8ci04o7d7oud5j2pj8i8jbbft057sjf.apps.googleusercontent.com";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created", // yalnız kendi oluşturduğu "Gazzla" takvimine yazar
  "https://www.googleapis.com/auth/calendar.events.readonly", // öbür takvimlerdeki etkinlikleri okur
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly", // takvim listesini okur
];
const API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_NAME = "Gazzla";

// ---------- Durum (bu cihazda) ----------

interface Link {
  eventId: string;
  hash: string; // bloğun Google'a en son gönderilen/alınan hali (değişti mi diye karşılaştırmak için)
  updated: string; // etkinliğin Google'daki "updated" zamanı (kendi değişikliğimizi tanımak için)
}

interface GcalState {
  owner: string; // hangi Gazzla hesabı
  connected: boolean;
  calendarId?: string;
  linked: Record<string, Link>; // blok id → Google etkinliği
  lastPull?: string; // en son "Gazzla" takviminden değişiklik çekilen an (ISO)
  lastSync?: number;
}

const STATE_KEY = "gazzla.gcal";
const EXT_KEY = "gazzla.gcalExternal";
const PROBE_KEY = "gazzla.gcalProbe"; // "bu hesap başka cihazda bağlanmış mı?" en son ne zaman bakıldı

function loadState(userId: string): GcalState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    const st = raw ? (JSON.parse(raw) as GcalState) : undefined;
    if (st && st.owner === userId) return st;
  } catch {
    /* bozuk kayıt: sıfırdan */
  }
  return { owner: userId, connected: false, linked: {} };
}

function saveState(st: GcalState): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(st));
}

let busy = false;
let lastError: string | undefined;

// Ekranın haberdar olması için dinleyiciler. "data" = program/etkinlikler değişti, "status" = sadece durum yazısı.
type Change = "data" | "status";
const listeners = new Set<(c: Change) => void>();
export function onGcalChange(fn: (c: Change) => void): void {
  listeners.add(fn);
}
const emit = (c: Change) => listeners.forEach((fn) => fn(c));

export interface GcalStatus {
  configured: boolean;
  connected: boolean;
  busy: boolean;
  error?: string;
  lastSync?: number;
}

export function gcalStatus(userId: string | undefined): GcalStatus {
  const configured = GOOGLE_CLIENT_ID !== "";
  if (!userId) return { configured, connected: false, busy: false };
  const st = loadState(userId);
  return { configured, connected: st.connected, busy, error: lastError, lastSync: st.lastSync };
}

// ---------- Anahtarlar ----------

class GcalError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

let token: { value: string; exp: number; owner: string } | undefined;

/** Sunucudaki gcal-auth fonksiyonunu çağırır. */
async function callAuth(body: Record<string, string>): Promise<{ access_token?: string; expires_in?: number; scope?: string }> {
  const { data, error } = await supabase.functions.invoke("gcal-auth", { body });
  if (!error) return data;
  let code = "";
  try {
    const ctx = (error as { context?: Response }).context;
    code = (await ctx?.json())?.error ?? "";
  } catch {
    /* gövde okunamadı */
  }
  const messages: Record<string, string> = {
    not_connected: "Google bağlantısı yok ya da Google hesabından izin kaldırılmış.",
    not_signed_in: "Google bağlantısı için Gazzla hesabına giriş yapmalısın.",
    not_configured: "Sunucuda Google ayarları eksik (GOOGLE_CLIENT_ID / SECRET).",
    no_refresh_token:
      "Google uzun süreli izni vermedi. Google hesabın → Güvenlik → Üçüncü taraf erişimi'nden Gazzla'yı kaldırıp tekrar bağlan.",
  };
  const msg = messages[code] ?? (error.message.includes("Failed to send") ? "Sunucuya ulaşılamadı (gcal-auth kurulu mu?)." : error.message);
  throw new GcalError(code || "auth_error", msg);
}

async function accessToken(userId: string): Promise<string> {
  if (token && token.owner === userId && token.exp > Date.now() + 60_000) return token.value;
  const r = await callAuth({ action: "token" });
  token = { value: r.access_token!, exp: Date.now() + (r.expires_in ?? 3600) * 1000, owner: userId };
  return token.value;
}

/** Google Calendar API isteği. 401 gelirse anahtarı yenileyip bir kez daha dener. */
async function api<T>(userId: string, method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken(userId)}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      token = undefined;
      continue;
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GcalError("http", data?.error?.message ?? res.statusText, res.status);
    return data as T;
  }
}

// ---------- Bağlan / bağlantıyı kes ----------

interface GoogleOAuth2 {
  initCodeClient(cfg: {
    client_id: string;
    scope: string;
    ux_mode: "popup";
    callback: (r: { code?: string; scope?: string; error?: string }) => void;
    error_callback?: (e: { type?: string }) => void;
  }): { requestCode(): void };
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
}

let gisPromise: Promise<void> | undefined;

/** Google'ın giriş betiğini önceden yükler (düğmeye basınca pencere hemen açılabilsin diye). */
export function preloadGoogle(): Promise<void> {
  if (!gisPromise) {
    gisPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gisPromise = undefined;
        reject(new Error("Google betiği yüklenemedi."));
      };
      document.head.append(s);
    });
  }
  return gisPromise;
}

/** Google izin penceresini açar. Mutlaka bir tıklamanın içinden çağrılmalı (yoksa tarayıcı pencereyi engeller). */
export function connectGoogle(userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      preloadGoogle().catch(() => {});
      reject(new Error("Google henüz yüklenmedi, bir saniye sonra tekrar dene."));
      return;
    }
    const client = oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES.join(" "),
      ux_mode: "popup",
      callback: async (resp) => {
        if (resp.error || !resp.code) return reject(new Error("Google izni verilmedi."));
        const granted = (resp.scope ?? "").split(" ");
        if (!SCOPES.every((s) => granted.includes(s)))
          return reject(new Error("Google penceresinde tüm kutuları işaretlemen gerekiyor."));
        try {
          const r = await callAuth({ action: "exchange", code: resp.code });
          token = { value: r.access_token!, exp: Date.now() + (r.expires_in ?? 3600) * 1000, owner: userId };
          const old = loadState(userId);
          saveState({ ...old, owner: userId, connected: true });
          lastError = undefined;
          emit("status");
          resolve();
        } catch (e) {
          reject(e);
        }
      },
      error_callback: (e) =>
        reject(new Error(e.type === "popup_closed" ? "Google penceresi kapatıldı." : "Google penceresi açılamadı.")),
    });
    client.requestCode();
  });
}

export async function disconnectGoogle(userId: string): Promise<void> {
  try {
    await callAuth({ action: "disconnect" });
  } finally {
    token = undefined;
    const st = loadState(userId);
    saveState({ owner: userId, connected: false, linked: {}, calendarId: st.calendarId });
    localStorage.removeItem(EXT_KEY);
    localStorage.removeItem(PROBE_KEY);
    lastError = undefined;
    emit("data");
  }
}

/**
 * Bu hesap başka bir cihazda Google'a bağlanmışsa bu cihaz da kendiliğinden bağlı sayılsın
 * (kullanıcı her cihazda tekrar "bağla" demesin). Günde en fazla bir kez sunucuya sorar.
 */
async function probe(userId: string): Promise<boolean> {
  const st = loadState(userId);
  if (st.connected) return true;
  const last = Number(localStorage.getItem(PROBE_KEY) ?? 0);
  if (Date.now() - last < 24 * 3600_000) return false;
  localStorage.setItem(PROBE_KEY, String(Date.now()));
  try {
    await accessToken(userId);
  } catch {
    return false;
  }
  saveState({ ...st, connected: true });
  emit("status");
  return true;
}

// ---------- Blok ↔ etkinlik ----------

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  updated: string;
  htmlLink?: string;
  recurringEventId?: string;
  recurrence?: string[];
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

const hashBlock = (b: Block) =>
  JSON.stringify([b.kind, b.subject ?? null, b.title ?? null, b.weekday ?? null, b.date ?? null, b.start, b.end, !!b.deleted]);

function addDays(key: string, n: number): string {
  const d = new Date(key + "T12:00");
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

function blockToEvent(b: Block): Record<string, unknown> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const monday = dayKey(mondayOf(0));
  const date = b.date ?? addDays(monday, b.weekday ?? 0); // tekrarlayan blok bu haftadan başlar
  const endDate = b.end >= 1440 ? addDays(date, 1) : date;
  const event: Record<string, unknown> = {
    summary: b.kind === "fixed" ? (b.title ?? "Etkinlik") : (b.subject ?? GENERAL),
    description: b.kind === "study" ? "Gazzla çalışma bloğu" : "Gazzla programından",
    start: { dateTime: `${date}T${clockText(b.start)}:00`, timeZone: tz },
    end: { dateTime: `${endDate}T${clockText(b.end % 1440)}:00`, timeZone: tz },
    extendedProperties: { private: { gazzlaId: b.id } },
    reminders: { useDefault: false }, // hatırlatmayı Gazzla zaten yapıyor
  };
  if (b.weekday !== undefined) event.recurrence = ["RRULE:FREQ=WEEKLY"];
  return event;
}

/** Etkinliğin saat/gün bilgisi. Tüm gün süren etkinliklerde undefined (programda saat bloğu olamaz). */
function eventTimes(ev: GEvent): Pick<Block, "start" | "end" | "weekday" | "date"> | undefined {
  if (!ev.start?.dateTime || !ev.end?.dateTime) return undefined;
  const s = new Date(ev.start.dateTime);
  const e = new Date(ev.end.dateTime);
  const start = s.getHours() * 60 + s.getMinutes();
  let end = dayKey(e) === dayKey(s) ? e.getHours() * 60 + e.getMinutes() : 1440;
  if (end <= start) end = Math.min(1440, start + 30);
  const weekly = (ev.recurrence ?? []).some((r) => /^RRULE:.*FREQ=WEEKLY/.test(r));
  return weekly ? { start, end, weekday: weekdayOf(s), date: undefined } : { start, end, weekday: undefined, date: dayKey(s) };
}

/** Başlık bir projenin adıysa o proje (büyük/küçük harf fark etmez). */
export function matchProject(title: string | undefined): string | undefined {
  const t = (title ?? "").trim().toLocaleLowerCase("tr");
  if (!t) return undefined;
  return loadSubjects().find((p) => p.toLocaleLowerCase("tr") === t);
}

// ---------- Eşitleme ----------

let running: Promise<boolean> | undefined;

/**
 * Gazzla programını "Gazzla" Google takvimiyle eşitler.
 * Dönen değer: programdaki bloklar Google yüzünden değişti mi (o zaman Supabase'e de yüklenmeli).
 */
export function gcalSync(userId: string): Promise<boolean> {
  if (GOOGLE_CLIENT_ID === "") return Promise.resolve(false);
  if (running) return running;
  running = (async () => {
    if (!(await probe(userId))) return false;
    const st = loadState(userId);
    busy = true;
    emit("status");
    try {
      await ensureCalendar(userId, st);
      let changed: boolean;
      try {
        changed = await pull(userId, st);
      } catch (e) {
        if (!(e instanceof GcalError && (e.status === 404 || e.status === 410))) throw e;
        // 404: "Gazzla" takvimi Google'da silinmiş → yeniden oluştur. 410: eski değişiklik listesi kullanılamaz.
        if (e.status === 404) {
          st.calendarId = undefined;
          st.linked = {};
          await ensureCalendar(userId, st);
        }
        st.lastPull = undefined;
        changed = await pull(userId, st);
      }
      await push(userId, st);
      st.lastSync = Date.now();
      lastError = undefined;
      saveState(st);
      if (changed) emit("data");
      return changed;
    } catch (e) {
      if (e instanceof GcalError && e.code === "not_connected") {
        saveState({ ...st, connected: false });
      }
      lastError = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy = false;
      running = undefined;
      emit("status");
    }
  })();
  return running;
}

async function ensureCalendar(userId: string, st: GcalState): Promise<void> {
  if (st.calendarId) return;
  // Daha önce (başka cihazda ya da eski bağlantıda) oluşturulmuş "Gazzla" takvimi var mı?
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ minAccessRole: "owner", maxResults: "250" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await api<{ items?: { id: string; summary?: string }[]; nextPageToken?: string }>(
      userId,
      "GET",
      `/users/me/calendarList?${q}`,
    );
    const found = r.items?.find((c) => c.summary === CALENDAR_NAME);
    if (found) {
      st.calendarId = found.id;
      st.lastPull = undefined;
      saveState(st);
      return;
    }
    pageToken = r.nextPageToken;
  } while (pageToken);

  const cal = await api<{ id: string }>(userId, "POST", "/calendars", {
    summary: CALENDAR_NAME,
    description: "Gazzla çalışma programı. Gazzla uygulamasıyla kendiliğinden eşitlenir.",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  st.calendarId = cal.id;
  st.linked = {};
  st.lastPull = undefined;
  saveState(st);
}

const calPath = (st: GcalState) => `/calendars/${encodeURIComponent(st.calendarId!)}/events`;

/** Google'da "Gazzla" takviminde değişenleri programa uygular. */
async function pull(userId: string, st: GcalState): Promise<boolean> {
  const startedAt = new Date(Date.now() - 2 * 60_000).toISOString(); // saat farkı payı
  const items: GEvent[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ maxResults: "2500", showDeleted: st.lastPull ? "true" : "false" });
    if (st.lastPull) q.set("updatedMin", st.lastPull);
    if (pageToken) q.set("pageToken", pageToken);
    const r = await api<{ items?: GEvent[]; nextPageToken?: string }>(userId, "GET", `${calPath(st)}?${q}`);
    items.push(...(r.items ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);

  const blocks = new Map(loadAllBlocks().map((b) => [b.id, b]));
  const byEvent = new Map(Object.entries(st.linked).map(([bid, l]) => [l.eventId, bid]));
  let changed = false;

  for (const ev of items) {
    if (ev.recurringEventId) continue; // tekrarlayan etkinliğin tek bir gününü değiştirmek: şimdilik yok sayılır
    const bid = ev.extendedProperties?.private?.gazzlaId ?? byEvent.get(ev.id);
    const link = bid ? st.linked[bid] : undefined;
    if (link && link.updated === ev.updated) continue; // bizim gönderdiğimiz değişiklik
    const block = bid ? blocks.get(bid) : undefined;

    if (ev.status === "cancelled") {
      // Google'da silinmiş. Bu cihazda bloğun gönderilmemiş bir değişikliği yoksa blok da silinsin.
      if (block && !block.deleted && (!link || link.hash === hashBlock(block))) {
        deleteBlock(block.id);
        changed = true;
        st.linked[block.id] = { eventId: ev.id, hash: hashBlock({ ...block, deleted: true }), updated: ev.updated };
      }
      continue;
    }

    const times = eventTimes(ev);
    if (!times) continue; // tüm gün etkinliği: programda yeri yok

    if (block) {
      if (!link) {
        // Bu cihaz bu etkinliği ilk kez görüyor (yeniden bağlanma / öbür cihaz). Bu cihazdaki hal esas.
        st.linked[block.id] = { eventId: ev.id, hash: "", updated: ev.updated };
        continue;
      }
      if (block.deleted || link.hash !== hashBlock(block)) continue; // burada gönderilmemiş değişiklik var: o kazanır
      const title = (ev.summary ?? "").trim();
      const next: Block = { ...block, ...times };
      if (title) {
        if (block.kind === "fixed") next.title = title;
        else next.subject = title === GENERAL ? undefined : title; // proje yoksa da olduğu gibi kalır, proje açılmaz
      }
      if (hashBlock(next) !== hashBlock(block)) {
        putBlock(next);
        changed = true;
      }
      st.linked[block.id] = { eventId: ev.id, hash: hashBlock(next), updated: ev.updated };
    } else if (!bid) {
      // Kullanıcı Google'da "Gazzla" takvimine kendisi eklemiş: programa blok olarak gelsin.
      // Adı bir projeyse çalışma bloğu, değilse olduğu gibi sabit blok (yeni proje AÇILMAZ).
      const title = (ev.summary ?? "").trim();
      const project = matchProject(title);
      const nb: Block = {
        id: crypto.randomUUID(),
        kind: project || title === GENERAL ? "study" : "fixed",
        subject: project,
        title: project || title === GENERAL ? undefined : title || "Etkinlik",
        ...times,
        updatedAt: Date.now(),
      };
      putBlock(nb);
      changed = true;
      const patched = await api<GEvent>(userId, "PATCH", `${calPath(st)}/${encodeURIComponent(ev.id)}`, {
        extendedProperties: { private: { gazzlaId: nb.id } },
      });
      st.linked[nb.id] = { eventId: ev.id, hash: hashBlock(nb), updated: patched.updated };
    }
    // bid var ama blok yok: başka cihazın bloğu, Supabase'den henüz gelmemiş. Gelince bağlanır.
  }
  st.lastPull = startedAt;
  saveState(st);
  return changed;
}

/** Programda değişen blokları Google'a gönderir. */
async function push(userId: string, st: GcalState): Promise<void> {
  for (const b of loadAllBlocks()) {
    const h = hashBlock(b);
    const link = st.linked[b.id];
    if (link && link.hash === h) continue;

    if (b.deleted) {
      if (link) {
        await api(userId, "DELETE", `${calPath(st)}/${encodeURIComponent(link.eventId)}`).catch((e) => {
          if (!(e instanceof GcalError && (e.status === 404 || e.status === 410))) throw e; // zaten silinmiş
        });
        st.linked[b.id] = { ...link, hash: h };
        saveState(st);
      }
      continue;
    }

    const body = blockToEvent(b);
    let ev: GEvent | undefined;
    let eventId: string | undefined = link?.eventId;
    if (!eventId) {
      // Başka bir cihaz bu bloğu Google'a çoktan göndermiş olabilir: çift etkinlik olmasın.
      const q = new URLSearchParams({ privateExtendedProperty: `gazzlaId=${b.id}`, maxResults: "1" });
      const r = await api<{ items?: GEvent[] }>(userId, "GET", `${calPath(st)}?${q}`);
      eventId = r.items?.[0]?.id;
    }
    if (eventId) {
      try {
        ev = await api<GEvent>(userId, "PUT", `${calPath(st)}/${encodeURIComponent(eventId)}`, body);
      } catch (e) {
        if (!(e instanceof GcalError && (e.status === 404 || e.status === 410))) throw e;
      }
    }
    if (!ev) ev = await api<GEvent>(userId, "POST", calPath(st), body);
    st.linked[b.id] = { eventId: ev.id, hash: h, updated: ev.updated };
    saveState(st); // her etkinlikten sonra kaydet: yarıda kesilirse çift göndermesin
  }
}

// ---------- Öbür takvimler (sadece okunur) ----------

export interface ExtEvent {
  id: string;
  title: string;
  calendar: string;
  color: string;
  date: string; // "2026-11-30"
  start: number; // dakika (tüm gün etkinliğinde 0)
  end: number; // dakika (tüm gün etkinliğinde 1440)
  allDay: boolean;
  link?: string;
}

interface ExtCache {
  owner: string;
  weeks: Record<string, { fetchedAt: number; events: ExtEvent[] }>; // anahtar: haftanın pazartesisi
}

function loadExt(userId: string): ExtCache {
  try {
    const raw = localStorage.getItem(EXT_KEY);
    const c = raw ? (JSON.parse(raw) as ExtCache) : undefined;
    if (c && c.owner === userId) return c;
  } catch {
    /* sıfırdan */
  }
  return { owner: userId, weeks: {} };
}

/** O günün Google etkinlikleri (öbür takvimlerden, önbellekten). */
export function externalOn(userId: string | undefined, day: Date): ExtEvent[] {
  if (!userId || GOOGLE_CLIENT_ID === "" || !loadState(userId).connected) return [];
  const monday = new Date(day);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - weekdayOf(monday));
  const key = dayKey(day);
  return (loadExt(userId).weeks[dayKey(monday)]?.events ?? []).filter((e) => e.date === key);
}

let calendarsCache: { at: number; owner: string; list: { id: string; name: string; color: string }[] } | undefined;
const fetching = new Map<string, Promise<boolean>>();
const failedAt = new Map<string, number>(); // inemeyen hafta: 1 dakika tekrar deneme (ekran yenilenip döngüye girmesin)

/**
 * Bir haftanın öbür takvimlerdeki etkinliklerini indirir (5 dakikadan eskiyse ya da force ile).
 * Dönen değer: ekranda gösterilenler değişti mi.
 */
export function fetchExternal(userId: string, weekOffset: number, force = false): Promise<boolean> {
  if (GOOGLE_CLIENT_ID === "" || !loadState(userId).connected) return Promise.resolve(false);
  const monday = mondayOf(weekOffset);
  const key = dayKey(monday);
  const entry = loadExt(userId).weeks[key];
  if (!force && entry && Date.now() - entry.fetchedAt < 5 * 60_000) return Promise.resolve(false);
  if (!force && Date.now() - (failedAt.get(key) ?? 0) < 60_000) return Promise.resolve(false);
  const inflight = fetching.get(key);
  if (inflight) return inflight;

  const job = (async () => {
    try {
      const st = loadState(userId);
      if (!calendarsCache || calendarsCache.owner !== userId || Date.now() - calendarsCache.at > 3600_000) {
        const r = await api<{
          items?: { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; selected?: boolean; deleted?: boolean }[];
        }>(userId, "GET", "/users/me/calendarList?maxResults=250");
        calendarsCache = {
          at: Date.now(),
          owner: userId,
          // Google'da işaretli (görünen) takvimler; "Gazzla" takviminin kendisi hariç.
          list: (r.items ?? [])
            .filter((c) => c.selected && !c.deleted && c.summary !== CALENDAR_NAME)
            .map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? "Takvim", color: c.backgroundColor ?? "#94a0b8" })),
        };
      }
      const timeMin = monday.toISOString();
      const end = new Date(monday);
      end.setDate(end.getDate() + 7);
      const timeMax = end.toISOString();
      const weekDays = new Set(Array.from({ length: 7 }, (_, i) => addDays(key, i)));

      const events: ExtEvent[] = [];
      for (const cal of calendarsCache.list) {
        if (cal.id === st.calendarId) continue;
        const q = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin, timeMax, maxResults: "250" });
        let items: GEvent[] = [];
        try {
          items = (await api<{ items?: GEvent[] }>(userId, "GET", `/calendars/${encodeURIComponent(cal.id)}/events?${q}`)).items ?? [];
        } catch {
          continue; // bu takvim okunamadı (izin yok vb.), öbürlerine devam
        }
        for (const ev of items) {
          if (ev.status === "cancelled") continue;
          if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue; // reddedilen davet
          const base = { id: ev.id, title: (ev.summary ?? "").trim() || "(Başlıksız)", calendar: cal.name, color: cal.color, link: ev.htmlLink };
          if (ev.start?.date && ev.end?.date) {
            // Tüm gün: bitiş tarihi dahil değil.
            for (let d = ev.start.date; d < ev.end.date; d = addDays(d, 1))
              if (weekDays.has(d)) events.push({ ...base, date: d, start: 0, end: 1440, allDay: true });
          } else if (ev.start?.dateTime && ev.end?.dateTime) {
            // Saatli: gece yarısını geçerse günlere böl.
            const s = new Date(ev.start.dateTime);
            const e = new Date(ev.end.dateTime);
            for (let d = dayKey(s); d <= dayKey(e); d = addDays(d, 1)) {
              const startMin = d === dayKey(s) ? s.getHours() * 60 + s.getMinutes() : 0;
              const endMin = d === dayKey(e) ? e.getHours() * 60 + e.getMinutes() : 1440;
              if (endMin > startMin && weekDays.has(d)) events.push({ ...base, date: d, start: startMin, end: endMin, allDay: false });
            }
          }
        }
      }

      const cache = loadExt(userId);
      const before = JSON.stringify(cache.weeks[key]?.events ?? null);
      cache.weeks[key] = { fetchedAt: Date.now(), events };
      // Eski haftaları at (önbellek büyümesin).
      const keys = Object.keys(cache.weeks).sort();
      while (keys.length > 8) delete cache.weeks[keys.shift()!];
      localStorage.setItem(EXT_KEY, JSON.stringify(cache));
      const changed = before !== JSON.stringify(events);
      if (changed) emit("data");
      return changed;
    } catch (e) {
      failedAt.set(key, Date.now());
      lastError = e instanceof Error ? e.message : String(e);
      emit("status");
      return false;
    } finally {
      fetching.delete(key);
    }
  })();
  fetching.set(key, job);
  return job;
}
