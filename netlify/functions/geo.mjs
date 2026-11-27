// Netlify Function: /api/geo
// Kullanıcının ülkesini (Netlify'ın kendi konum bilgisinden) okuyup İMZALI bir fiş verir:
//   "ülke.son-geçerlilik.imza"   ör. "TR.1795900000000.abc..."
// Supabase'teki gazzla-ai fonksiyonu bu fişi aynı gizli anahtarla (GEO_SECRET) doğrular; böylece
// kullanıcı ülkesini değiştiremez ve IP adresi hiçbir üçüncü servise gönderilmez.
// Gerekli: Netlify → Site configuration → Environment variables → GEO_SECRET (Supabase'tekiyle aynı).

const b64url = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export default async (_req, context) => {
  const secret = process.env.GEO_SECRET;
  const country = (context.geo?.country?.code ?? "").toUpperCase();
  if (!secret || !country) {
    return Response.json({ country: country || null, token: null }, { headers: { "Cache-Control": "no-store" } });
  }
  const exp = Date.now() + 6 * 3600_000; // 6 saat geçerli
  const payload = `${country}.${exp}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return Response.json({ country, token: `${payload}.${sig}` }, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/geo" };
