// Supabase bağlantısı. Uygulamanın geri kalanı Supabase'e hep bu dosyadaki `supabase` nesnesi
// üzerinden konuşacak. C++'la düşünürsen: programın başında bir kere açılan, her yerden
// kullanılan tek bir bağlantı nesnesi (global bir "client").

import { createClient } from "@supabase/supabase-js";

// Projenin adresi ve "publishable" (eski adıyla anon) anahtarı.
// Bu anahtar herkese açık olacak şekilde tasarlandı: tarayıcıya giden her uygulamada zaten görünür.
// Verileri koruyan şey anahtarı gizlemek değil, Supabase'deki RLS kuralları.
// (Asla buraya "secret" ya da "service_role" anahtarı koyma; o gerçekten gizli.)
const url = "https://oeloqmdhffbehavolwik.supabase.co";
const key = "sb_publishable_rbHGP0wdh0D5xxkw5_CDjA_k8OM2TzI";

export const supabase = createClient(url, key);
export const SUPABASE_URL = url;
export const SUPABASE_KEY = key;

/**
 * Sadece bağlantıyı denemek için: henüz hiç tablo yok, o yüzden olmayan bir tabloyu soruyoruz.
 * Supabase "böyle bir tablo yok" diye cevap verirse sunucuya ulaşmışız demektir, bu da başarı.
 * İnternet yoksa ya da anahtar yanlışsa farklı bir hata gelir.
 */
export async function checkConnection(): Promise<{ ok: boolean; detail: string }> {
  const { error } = await supabase.from("baglanti_testi").select("*").limit(1);
  if (!error) return { ok: true, detail: "Bağlandı." };
  // PGRST205 = tablo bulunamadı, 42P01 = tablo yok. İkisi de sunucunun cevap verdiğini gösterir.
  if (error.code === "PGRST205" || error.code === "42P01") return { ok: true, detail: "Bağlandı (henüz tablo yok)." };
  return { ok: false, detail: error.message };
}

// ---------- Giriş (hesap) ----------
// Supabase'in hazır giriş sistemi: e-posta + şifre. Şifreler Supabase'de güvenli şekilde
// saklanıyor; biz şifreyi hiçbir yere kaydetmiyoruz. Giriş yapınca Supabase tarayıcıda bir
// "oturum" saklıyor, uygulamayı kapatıp açsan da giriş yapılmış kalıyorsun.

export interface AuthUser {
  id: string;
  email: string;
}

function toAuthUser(user: { id: string; email?: string } | null | undefined): AuthUser | null {
  return user ? { id: user.id, email: user.email ?? "" } : null;
}

/** Şu an giriş yapmış kullanıcı ya da null. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const { data } = await supabase.auth.getSession();
  return toAuthUser(data.session?.user);
}

/** Giriş/çıkış olduğunda (başka sekmede bile) çağrılır. */
export function onAuthChange(callback: (user: AuthUser | null) => void): void {
  supabase.auth.onAuthStateChange((_event, session) => callback(toAuthUser(session?.user)));
}

/** Hata varsa Türkçe mesaj döner, yoksa undefined. */
export async function signIn(email: string, password: string): Promise<string | undefined> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? translateAuthError(error.message) : undefined;
}

/**
 * Yeni hesap. Supabase ayarlarında e-posta onayı açıksa hesap hemen açılmaz,
 * e-postaya onay linki gider: o zaman needsConfirm = true döner.
 */
export async function signUp(
  email: string,
  password: string,
): Promise<{ error?: string; needsConfirm: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // Onay linkine tıklayınca bu adrese (uygulamaya) dönülür.
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) return { error: translateAuthError(error.message), needsConfirm: false };
  return { needsConfirm: !data.session };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Supabase'in İngilizce hata mesajlarını anlaşılır Türkçeye çevirir. */
function translateAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "E-posta ya da şifre yanlış.";
  if (m.includes("email not confirmed")) return "Önce e-postana gelen onay linkine tıkla.";
  if (m.includes("already registered")) return "Bu e-postayla zaten bir hesap var. Giriş yapmayı dene.";
  if (m.includes("password should be at least")) return "Şifre en az 6 karakter olmalı.";
  if (m.includes("invalid") && m.includes("email")) return "E-posta adresi geçersiz görünüyor.";
  if (m.includes("rate limit") || m.includes("too many")) return "Çok fazla deneme oldu. Biraz bekleyip tekrar dene.";
  if (m.includes("failed to fetch") || m.includes("network")) return "İnternete bağlanılamadı.";
  return message; // tanımadığımız hata: olduğu gibi göster
}
