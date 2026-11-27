// Gazzla AI'nin sunucusuyla konuşan tek yer.
//   - Canlı sitede: Supabase'teki "gazzla-ai" fonksiyonu (giriş şart, günlük hak, ülke fişi).
//   - `npm run dev`'de: aynı fonksiyon yerelde (vite.config.ts), giriş gerekmez.
// Ülke fişi: Netlify'daki /api/geo fonksiyonu kullanıcının ülkesini imzalayıp verir; biz onu sunucuya iletiriz.

import { supabase, SUPABASE_KEY, SUPABASE_URL } from "./supabase";

const DEV = import.meta.env.DEV;
const BASE = DEV ? "/api/gazzla-ai" : `${SUPABASE_URL}/functions/v1/gazzla-ai`;

let geo: { token: string | null; exp: number } | undefined;

/** Netlify'dan imzalı ülke fişi (6 saat geçerli; bitmeden yenilenir). Alınamazsa null. */
async function geoToken(): Promise<string | null> {
  if (DEV) return null;
  if (geo && geo.exp - Date.now() > 10 * 60_000) return geo.token;
  try {
    const res = await fetch("/api/geo", { cache: "no-store" });
    const j = (await res.json()) as { token?: string | null };
    const token = j.token ?? null;
    geo = { token, exp: Number(token?.split(".")[1]) || Date.now() + 3600_000 };
    return token;
  } catch {
    return null;
  }
}

/** Sunucuya istek. route: "coach" | "study" | "transcribe" | "upload" | "ocr" | "status". */
export async function aiFetch(route: string, body: BodyInit, contentType = "application/json"): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (!DEV) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("not-signed-in");
    headers.Authorization = `Bearer ${token}`;
    headers.apikey = SUPABASE_KEY;
    const g = await geoToken();
    if (g) headers["x-gazzla-geo"] = g;
  }
  return fetch(`${BASE}/${route}`, { method: "POST", headers, body });
}

export interface AiStatus {
  study: "files" | "excerpts"; // ders asistanı: dosyaları servis mi okuyor, yoksa tarayıcı alıntı mı çıkarıyor (ülkeye göre)
  country: string | null;
  left: { coach: number; study: number; ocr: number }; // bugün kalan haklar
}

let status: AiStatus | undefined;
let loading: Promise<AiStatus | undefined> | undefined;

/** Sunucudan durum (yol + kalan haklar). Bir kez yüklenir; force ile yenilenir. */
export function loadStatus(force = false): Promise<AiStatus | undefined> {
  if (status && !force) return Promise.resolve(status);
  loading ??= aiFetch("status", "{}")
    .then(async (res) => (res.ok ? ((status = (await res.json()) as AiStatus), status) : undefined))
    .catch(() => undefined)
    .finally(() => (loading = undefined));
  return loading;
}

export function statusNow(): AiStatus | undefined {
  return status;
}

/** Bir hak kullanıldı (ekrandaki sayıyı sunucuya tekrar sormadan güncellemek için). */
export function spent(kind: "coach" | "study" | "ocr"): void {
  if (status) status.left[kind] = Math.max(0, status.left[kind] - 1);
}

/** Giriş yapılmış mı (canlıda Gazzla AI için şart). Yerelde hep true. */
export async function canUseAi(): Promise<boolean> {
  if (DEV) return true;
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session);
}
