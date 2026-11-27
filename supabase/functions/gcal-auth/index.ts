// Supabase Edge Function: gcal-auth
// Google Calendar bağlantısının "anahtar kasası".
//
// Neden gerekli? Google'ın uzun ömürlü yenileme anahtarını (refresh token) almak ve kullanmak için
// "client secret" gerekiyor; o da tarayıcıya konamaz (herkes görür). Bu fonksiyon sunucuda çalışır:
//   - "exchange": Google'ın verdiği tek kullanımlık kodu yenileme anahtarına çevirir, kasaya koyar.
//   - "token":    kasadaki anahtarla 1 saatlik erişim anahtarı üretip tarayıcıya verir.
//   - "disconnect": anahtarı Google'da iptal eder ve kasadan siler.
// Böylece kullanıcı Google'a bir kez izin verir, sonra hiç açılır pencere görmez.
//
// Gerekli gizli değerler (Supabase → Edge Functions → Secrets):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY Supabase tarafından kendiliğinden verilir.

import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return json({ error: "not_configured" }, 500);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // İsteği yapan Gazzla kullanıcısı kim? (Supabase giriş anahtarından)
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (!user) return json({ error: "not_signed_in" }, 401);

  let body: { action?: string; code?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* boş gövde */
  }

  if (body.action === "exchange") {
    if (!body.code) return json({ error: "no_code" }, 400);
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: body.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: "postmessage", // Google'ın açılır pencere (popup) akışı için sabit değer
        grant_type: "authorization_code",
      }),
    });
    const tok = await res.json();
    if (!res.ok) return json({ error: "exchange_failed", detail: tok.error_description ?? tok.error }, 400);

    if (tok.refresh_token) {
      const { error } = await admin.from("google_tokens").upsert({
        user_id: user.id,
        refresh_token: tok.refresh_token,
        scope: tok.scope ?? null,
        updated_at: new Date().toISOString(),
      });
      if (error) return json({ error: "store_failed", detail: error.message }, 500);
    } else {
      // Google yenileme anahtarını yalnız ilk izinde verir. Kasada zaten varsa sorun yok.
      const { data } = await admin.from("google_tokens").select("user_id").eq("user_id", user.id).maybeSingle();
      if (!data) return json({ error: "no_refresh_token" }, 400);
    }
    return json({ access_token: tok.access_token, expires_in: tok.expires_in, scope: tok.scope });
  }

  if (body.action === "token") {
    const { data } = await admin.from("google_tokens").select("refresh_token").eq("user_id", user.id).maybeSingle();
    if (!data) return json({ error: "not_connected" }, 404);
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: data.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
    });
    const tok = await res.json();
    if (!res.ok) {
      // invalid_grant = kullanıcı Google hesabından izni kaldırmış: kasayı temizle, yeniden bağlansın.
      if (tok.error === "invalid_grant") {
        await admin.from("google_tokens").delete().eq("user_id", user.id);
        return json({ error: "not_connected" }, 404);
      }
      return json({ error: "refresh_failed", detail: tok.error_description ?? tok.error }, 502);
    }
    return json({ access_token: tok.access_token, expires_in: tok.expires_in, scope: tok.scope });
  }

  if (body.action === "disconnect") {
    const { data } = await admin.from("google_tokens").select("refresh_token").eq("user_id", user.id).maybeSingle();
    if (data) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(data.refresh_token)}`, {
        method: "POST",
      }).catch(() => {});
      await admin.from("google_tokens").delete().eq("user_id", user.id);
    }
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});
