// Arkadaşlar: kullanıcı adı, arkadaşlık istekleri, arkadaşların süreleri ve "şu an çalışıyor" durumu.
// Tüm Supabase sorguları burada; main.ts sadece bu fonksiyonları çağırıp ekranı çiziyor.
//
// Gizlilik: Arkadaşlar birbirinin PROJE adlarını göremez. Süreler veritabanındaki
// friend_totals() fonksiyonundan sadece toplam olarak gelir, durum (presence) tablosunda da proje yok.

import { supabase } from "./supabase";
import { startOfWeek } from "./storage";

export interface Profile {
  id: string;
  username: string;
}

/** Bir arkadaşın şu anki durumu (yoksa null). */
export interface Presence {
  kind: "work" | "break";
  endsAt: number; // seansın bitmesi beklenen an (ms)
  paused: boolean;
  updatedAt: number;
}

export interface Friend extends Profile {
  todayMin: number;
  weekMin: number;
  presence: Presence | null;
}

export interface FriendsOverview {
  friends: Friend[];
  incoming: Profile[]; // bana gelen, kabul bekleyen istekler
  outgoing: Profile[]; // benim gönderdiğim, karşı tarafın kabulünü bekleyen istekler
}

// ---------- Kullanıcı adı ----------

/** "@Ahmet " → "ahmet". Kullanıcı adları hep küçük harf. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

export function usernameProblem(name: string): string | undefined {
  if (!/^[a-z0-9_]{3,20}$/.test(name))
    return "Kullanıcı adı 3-20 karakter olmalı; sadece İngilizce harf, rakam ve _ kullanılabilir.";
  return undefined;
}

export async function getMyProfile(myId: string): Promise<Profile | null> {
  const { data } = await supabase.from("profiles").select("id, username").eq("id", myId).maybeSingle();
  return (data as Profile | null) ?? null;
}

/** Kullanıcı adını kaydeder (yoksa oluşturur). Hata varsa Türkçe mesaj döner. */
export async function saveUsername(myId: string, raw: string): Promise<string | undefined> {
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem) return problem;
  const { error } = await supabase.from("profiles").upsert({ id: myId, username });
  if (!error) return undefined;
  if (error.code === "23505") return `"${username}" alınmış, başka bir ad dene.`; // 23505 = benzersizlik ihlali
  return explain(error);
}

// ---------- Arkadaşlık istekleri ----------

interface FriendshipRow {
  requester: string;
  addressee: string;
  status: "pending" | "accepted";
}

async function myFriendships(myId: string): Promise<FriendshipRow[]> {
  const { data, error } = await supabase.from("friendships").select("requester, addressee, status");
  if (error) throw new Error(explain(error));
  // RLS zaten sadece benim dahil olduğum satırları veriyor; yine de emin olalım.
  return ((data ?? []) as FriendshipRow[]).filter((f) => f.requester === myId || f.addressee === myId);
}

/** Kullanıcı adıyla istek gönderir. Sonuç mesajını döner (başarılı ya da hata). */
export async function sendFriendRequest(myId: string, raw: string): Promise<{ ok: boolean; message: string }> {
  const username = normalizeUsername(raw);
  if (!username) return { ok: false, message: "Bir kullanıcı adı yaz." };

  const { data: other, error } = await supabase
    .from("profiles")
    .select("id, username")
    .eq("username", username)
    .maybeSingle();
  if (error) return { ok: false, message: explain(error) };
  if (!other) return { ok: false, message: `"${username}" diye bir kullanıcı yok.` };
  const target = other as Profile;
  if (target.id === myId) return { ok: false, message: "Kendini ekleyemezsin 🙂" };

  // Aramızda zaten bir kayıt var mı?
  const existing = (await myFriendships(myId)).find(
    (f) => f.requester === target.id || f.addressee === target.id,
  );
  if (existing?.status === "accepted") return { ok: false, message: `@${username} ile zaten arkadaşsınız.` };
  if (existing && existing.requester === myId) return { ok: false, message: "İstek zaten gönderildi, kabul etmesini bekle." };
  if (existing) {
    // O bana önceden istek atmış: göndermek yerine kabul et.
    const err = await acceptRequest(target.id, myId);
    return err
      ? { ok: false, message: err }
      : { ok: true, message: `@${username} seni zaten eklemişti, artık arkadaşsınız! 🎉` };
  }

  const { error: insertError } = await supabase
    .from("friendships")
    .insert({ requester: myId, addressee: target.id, status: "pending" });
  if (insertError) return { ok: false, message: explain(insertError) };
  return { ok: true, message: `@${username} kullanıcısına istek gönderildi.` };
}

export async function acceptRequest(requesterId: string, myId: string): Promise<string | undefined> {
  const { error } = await supabase
    .from("friendships")
    .update({ status: "accepted" })
    .eq("requester", requesterId)
    .eq("addressee", myId);
  return error ? explain(error) : undefined;
}

/** İsteği reddet / iptal et ya da arkadaşlıktan çıkar (aramızdaki kaydı sil). */
export async function removeFriendship(otherId: string, myId: string): Promise<string | undefined> {
  const { error } = await supabase
    .from("friendships")
    .delete()
    .or(`and(requester.eq.${myId},addressee.eq.${otherId}),and(requester.eq.${otherId},addressee.eq.${myId})`);
  return error ? explain(error) : undefined;
}

// ---------- Arkadaşlar ekranı için hepsi bir arada ----------

export async function loadFriendsOverview(myId: string): Promise<FriendsOverview> {
  const rows = await myFriendships(myId);
  const otherId = (f: FriendshipRow) => (f.requester === myId ? f.addressee : f.requester);
  const ids = [...new Set(rows.map(otherId))];
  if (ids.length === 0) return { friends: [], incoming: [], outgoing: [] };

  // Kullanıcı adları
  const { data: profileData, error: pErr } = await supabase.from("profiles").select("id, username").in("id", ids);
  if (pErr) throw new Error(explain(pErr));
  const names = new Map(((profileData ?? []) as Profile[]).map((p) => [p.id, p.username]));
  const profile = (id: string): Profile => ({ id, username: names.get(id) ?? "?" });

  const accepted = rows.filter((f) => f.status === "accepted").map(otherId);

  // Süreler (sadece toplamlar, proje adları yok) ve şu anki durumlar
  const totals = await friendTotals();
  const presence = await loadPresence(accepted);

  return {
    friends: accepted.map((id) => ({
      ...profile(id),
      todayMin: totals.get(id)?.todayMin ?? 0,
      weekMin: totals.get(id)?.weekMin ?? 0,
      presence: presence.get(id) ?? null,
    })),
    incoming: rows.filter((f) => f.status === "pending" && f.addressee === myId).map((f) => profile(f.requester)),
    outgoing: rows.filter((f) => f.status === "pending" && f.requester === myId).map((f) => profile(f.addressee)),
  };
}

async function friendTotals(): Promise<Map<string, { todayMin: number; weekMin: number }>> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { data, error } = await supabase.rpc("friend_totals", {
    day_start: dayStart.toISOString(),
    week_start: startOfWeek().toISOString(),
  });
  if (error) throw new Error(explain(error));
  const map = new Map<string, { todayMin: number; weekMin: number }>();
  for (const r of (data ?? []) as { user_id: string; today_ms: number; week_ms: number }[]) {
    map.set(r.user_id, { todayMin: Number(r.today_ms) / 60000, weekMin: Number(r.week_ms) / 60000 });
  }
  return map;
}

// ---------- "Şu an çalışıyor" ----------

interface PresenceRow {
  user_id: string;
  kind: "work" | "break";
  ends_at: string;
  paused: boolean;
  updated_at: string;
}

/**
 * Bir durum hâlâ geçerli mi? Uygulama seans bitmeden kapatılırsa satır silinemeyebilir,
 * o yüzden bitiş zamanı geçmiş (ya da 3 saatten uzun süredir duraklatılmış) durumları yok sayıyoruz.
 */
export function isActive(p: Presence | null, now = Date.now()): p is Presence {
  if (!p) return false;
  if (p.paused) return now - p.updatedAt < 3 * 3600_000;
  return p.endsAt > now;
}

async function loadPresence(ids: string[]): Promise<Map<string, Presence>> {
  const map = new Map<string, Presence>();
  if (ids.length === 0) return map;
  const { data, error } = await supabase
    .from("presence")
    .select("user_id, kind, ends_at, paused, updated_at")
    .in("user_id", ids);
  if (error) throw new Error(explain(error));
  for (const r of (data ?? []) as PresenceRow[]) {
    const p: Presence = {
      kind: r.kind,
      endsAt: Date.parse(r.ends_at),
      paused: r.paused,
      updatedAt: Date.parse(r.updated_at),
    };
    if (isActive(p)) map.set(r.user_id, p);
  }
  return map;
}

/** Şu an aktif (çalışan / ara veren / duraklatmış) arkadaşlar. Zamanlayıcı ekranındaki satır için. */
export async function loadActiveFriends(myId: string): Promise<(Profile & { presence: Presence })[]> {
  const { data, error } = await supabase
    .from("presence")
    .select("user_id, kind, ends_at, paused, updated_at")
    .neq("user_id", myId); // RLS sadece arkadaşlarınkini veriyor
  if (error || !data || data.length === 0) return [];
  const active = (data as PresenceRow[])
    .map((r) => ({
      id: r.user_id,
      presence: { kind: r.kind, endsAt: Date.parse(r.ends_at), paused: r.paused, updatedAt: Date.parse(r.updated_at) },
    }))
    .filter((x) => isActive(x.presence));
  if (active.length === 0) return [];
  const { data: profiles } = await supabase.from("profiles").select("id, username").in("id", active.map((a) => a.id));
  const names = new Map(((profiles ?? []) as Profile[]).map((p) => [p.id, p.username]));
  return active.map((a) => ({ ...a, username: names.get(a.id) ?? "?" }));
}

/** Kendi durumumu yaz (seans başlayınca, duraklatınca, devam edince). Hata olursa sessizce geç. */
export async function setPresence(
  myId: string,
  p: { kind: "work" | "break"; startedAt: number; endsAt: number; paused: boolean },
): Promise<void> {
  await supabase.from("presence").upsert({
    user_id: myId,
    kind: p.kind,
    started_at: new Date(p.startedAt).toISOString(),
    ends_at: new Date(p.endsAt).toISOString(),
    paused: p.paused,
    updated_at: new Date().toISOString(),
  });
}

/** Seans bitince durumu sil. */
export async function clearPresence(myId: string): Promise<void> {
  await supabase.from("presence").delete().eq("user_id", myId);
}

function explain(error: { code?: string; message: string }): string {
  if (error.code === "PGRST205" || error.code === "42P01" || error.code === "PGRST202")
    return "Supabase'de arkadaş tabloları yok. 02_friends.sql'i SQL Editor'de çalıştırdın mı?";
  if (error.message.toLowerCase().includes("failed to fetch")) return "İnternete bağlanılamadı.";
  return error.message;
}
