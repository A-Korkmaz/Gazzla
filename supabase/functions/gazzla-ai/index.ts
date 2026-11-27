// Supabase Edge Function: gazzla-ai
// Gazzla AI'nin sunucu tarafı. Yapay zeka servislerinin anahtarları SADECE burada durur; tarayıcı servislerin
// adını bile görmez. Aynı dosya `npm run dev` sırasında vite.config.ts tarafından da kullanılır (geliştirme).
//
// Yollar (POST, gövde JSON; transcribe/upload ham dosya):
//   status      → { study: "files" (Gemini) | "excerpts" (Groq), country, left: {coach, study, ocr} }
//   coach       → Koç sohbeti (Groq). Cevap: satır satır JSON (NDJSON): {"text"} ya da {"tool","args"}
//   transcribe  → ses kaydı → yazı (Groq)
//   study       → Ders asistanı. Ülkeye göre: Gemini (dosyaları kendisi okur) ya da Groq (tarayıcının
//                 çıkardığı alıntılarla). Cevap NDJSON.
//   upload      → materyali Gemini'ye yükler (yalnız Gemini bölgesinde)
//   ocr         → bir sayfa görüntüsünün yazısını okur (Groq, görsel model)
//
// Kurallar:
//   - Giriş şart (Supabase oturumu). Her kullanıcının günlük hakkı var (ai_usage tablosu, 06_ai.sql).
//   - Ülke, Netlify'daki /api/geo fonksiyonunun imzaladığı fişten okunur (x-gazzla-geo başlığı). Gemini'nin
//     şartları AEA/İsviçre/İngiltere'deki kullanıcılara ücretsiz sürümle hizmeti yasaklıyor; o ülkeler ve
//     fişi olmayan herkes Groq'a gider.
//
// Gizli değerler (Supabase → Edge Functions → Secrets): GROQ_API_KEY, GEMINI_API_KEY, GEO_SECRET
// İsteğe bağlı: GEMINI_MODEL, AI_LIMIT_COACH (60), AI_LIMIT_STUDY (25), AI_LIMIT_OCR (80)
// SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY Supabase tarafından kendiliğinden verilir.
//
// Not: dış kütüphane kullanmıyoruz (yalnız fetch), ki aynı kod Node'da (dev) da çalışsın.

export interface Env {
  get(name: string): string | undefined;
}
export interface Opts {
  dev?: boolean; // yerel geliştirme: giriş ve günlük hak kontrolü yok, ülke DEV_COUNTRY (varsayılan TR)
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-gazzla-geo",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Gemini'nin ücretsiz sürümüyle hizmet verilemeyen bölgeler: AEA (AB + İzlanda, Lihtenştayn, Norveç), İsviçre, İngiltere.
const RESTRICTED = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH GB".split(" "),
);

const GROQ = "https://api.groq.com/openai/v1";
const GROQ_CHAT = "openai/gpt-oss-120b";
const GROQ_VISION = "qwen/qwen3.8-27b";
const GROQ_WHISPER = "whisper-large-v3-turbo";
const GEMINI = "https://generativelanguage.googleapis.com";

type Kind = "coach" | "study" | "ocr";

// ---------- Giriş, ülke, günlük hak ----------

async function userIdOf(req: Request, env: Env): Promise<string | undefined> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const url = env.get("SUPABASE_URL");
  const service = env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!jwt || !url || !service) return undefined;
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) return undefined;
  const user = (await res.json()) as { id?: string };
  return user.id;
}

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

/** Netlify'ın imzaladığı "ülke.son-geçerlilik.imza" fişini doğrular. Geçersizse undefined. */
async function countryOf(token: string | null, secret: string | undefined): Promise<string | undefined> {
  if (!token || !secret) return undefined;
  const [country, exp, sig] = token.split(".");
  if (!country || !exp || !sig || Number(exp) < Date.now()) return undefined;
  const expected = await hmac(secret, `${country}.${exp}`);
  if (expected.length !== sig.length) return undefined;
  let diff = 0; // sabit süreli karşılaştırma (imzayı tahmin etmeyi zorlaştırır)
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? country.toUpperCase() : undefined;
}

function limitOf(env: Env, kind: Kind): number {
  const def = { coach: 60, study: 25, ocr: 80 }[kind];
  return Number(env.get(`AI_LIMIT_${kind.toUpperCase()}`)) || def;
}

/** Günlük haktan bir tane kullanır. false = bugünkü hak bitti. */
async function useOne(env: Env, userId: string, kind: Kind): Promise<boolean> {
  const res = await fetch(`${env.get("SUPABASE_URL")}/rest/v1/rpc/ai_use`, {
    method: "POST",
    headers: {
      apikey: env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      Authorization: `Bearer ${env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_user: userId, p_kind: kind, p_limit: limitOf(env, kind) }),
  });
  if (!res.ok) throw new Error(`ai_use ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) !== -1;
}

async function leftToday(env: Env, userId: string): Promise<Record<Kind, number>> {
  const day = new Date().toISOString().slice(0, 10); // veritabanındaki current_date de UTC
  const res = await fetch(
    `${env.get("SUPABASE_URL")}/rest/v1/ai_usage?user_id=eq.${userId}&day=eq.${day}&select=coach,study,ocr`,
    { headers: { apikey: env.get("SUPABASE_SERVICE_ROLE_KEY")!, Authorization: `Bearer ${env.get("SUPABASE_SERVICE_ROLE_KEY")}` } },
  );
  const row = res.ok ? ((await res.json()) as Record<Kind, number>[])[0] : undefined;
  return {
    coach: limitOf(env, "coach") - (row?.coach ?? 0),
    study: limitOf(env, "study") - (row?.study ?? 0),
    ocr: limitOf(env, "ocr") - (row?.ocr ?? 0),
  };
}

// ---------- Akış yardımcıları ----------

const enc = new TextEncoder();

/**
 * Servisin SSE akışını ("data: {...}" satırları) okuyup bizim NDJSON satırlarımıza çevirir.
 * pick: her "data" JSON'undan yazılacak satırları üretir. Akış 45 sn durursa notla kapatır.
 */
function sseToNdjson(
  upstream: Response,
  pick: (data: unknown, out: (obj: unknown) => void) => void,
  finish?: (out: (obj: unknown) => void) => void,
): Response {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      const handle = (line: string) => {
        const t = line.trim();
        if (!t.startsWith("data:")) return;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        try {
          pick(JSON.parse(payload), out);
        } catch {
          /* bozuk satırı atla */
        }
      };
      let buffer = "";
      try {
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stalled = new Promise<"stalled">((r) => (timer = setTimeout(() => r("stalled"), 45_000)));
          const next = await Promise.race([reader.read(), stalled]);
          clearTimeout(timer);
          if (next === "stalled") {
            reader.cancel().catch(() => {});
            out({ text: "\n\n(Cevap yarıda kesildi; servis şu an çok yoğun. Biraz sonra tekrar sor.)" });
            break;
          }
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          lines.forEach(handle);
        }
        handle(buffer);
        finish?.(out);
      } catch {
        out({ text: "\n\n(Bağlantı koptu.)" });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...CORS, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" } });
}

// ---------- Groq ----------

type ChatMsg = { role: "system" | "user" | "assistant"; content: unknown };

async function groqStream(env: Env, body: Record<string, unknown>): Promise<Response> {
  const key = env.get("GROQ_API_KEY");
  if (!key) return json({ error: "not-configured" }, 503);
  const upstream = await fetch(`${GROQ}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  }).catch(() => undefined);
  if (!upstream) return json({ error: "network" }, 502);
  if (!upstream.ok || !upstream.body) {
    console.warn("[gazzla-ai] groq", upstream.status, (await upstream.text().catch(() => "")).slice(0, 300));
    return json({ error: upstream.status === 429 ? "rate-limit" : "upstream" }, upstream.status === 429 ? 429 : 502);
  }
  // Araç çağrılarının argümanları parça parça gelir; sırasına göre birleştirip en sonda yazıyoruz.
  const tools = new Map<number, { name: string; args: string }>();
  return sseToNdjson(
    upstream,
    (data, out) => {
      const delta = (data as { choices?: { delta?: { content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] } }[] })
        .choices?.[0]?.delta;
      if (delta?.content) out({ text: delta.content });
      for (const tc of delta?.tool_calls ?? []) {
        const cur = tools.get(tc.index ?? 0) ?? { name: "", args: "" };
        cur.name += tc.function?.name ?? "";
        cur.args += tc.function?.arguments ?? "";
        tools.set(tc.index ?? 0, cur);
      }
    },
    (out) => tools.forEach((t) => out({ tool: t.name, args: t.args })),
  );
}

function cleanMessages(list: unknown): ChatMsg[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && ["system", "user", "assistant"].includes(m.role) && (typeof m.content === "string" || Array.isArray(m.content)))
    .slice(-30) as ChatMsg[];
}

async function coach(env: Env, body: { messages?: unknown; tools?: unknown[] }): Promise<Response> {
  const tools = Array.isArray(body.tools) && body.tools.length ? body.tools.slice(0, 5) : undefined;
  return groqStream(env, {
    model: GROQ_CHAT,
    messages: cleanMessages(body.messages).filter((m) => typeof m.content === "string"),
    temperature: 0.7,
    max_tokens: 2048,
    reasoning_effort: tools ? "medium" : "low",
    ...(tools ? { tools, tool_choice: "auto" } : {}),
  });
}

async function transcribe(env: Env, req: Request): Promise<Response> {
  const key = env.get("GROQ_API_KEY");
  if (!key) return json({ error: "not-configured" }, 503);
  const data = await req.arrayBuffer();
  if (data.byteLength > 20 * 1024 * 1024) return json({ error: "too-big" }, 413);
  const type = (req.headers.get("content-type") || "audio/webm").split(";")[0];
  const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([data], { type }), `kayit.${ext}`);
  form.append("model", GROQ_WHISPER);
  form.append("response_format", "json");
  const res = await fetch(`${GROQ}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }).catch(
    () => undefined,
  );
  if (!res?.ok) return json({ error: res?.status === 429 ? "rate-limit" : "upstream" }, 502);
  const { text } = (await res.json()) as { text?: string };
  return json({ text: (text ?? "").trim() });
}

/** Bir sayfa görüntüsünün yazısını Groq'un görsel modeliyle okur (taranmış PDF'ler, fotoğraflar). */
async function ocr(env: Env, body: { image?: string }): Promise<Response> {
  const key = env.get("GROQ_API_KEY");
  if (!key) return json({ error: "not-configured" }, 503);
  if (!body.image || !/^data:image\/[\w.+-]+;base64,/.test(body.image)) return json({ error: "bad-image" }, 400);
  const res = await fetch(`${GROQ}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_VISION,
      max_tokens: 2500,
      temperature: 0,
      reasoning_effort: "none",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Bu sayfadaki bütün yazıyı olduğu gibi, orijinal dilinde yaz. Formülleri düz yazı ve Unicode ile yaz (x², √, ∫, ≤). " +
                "Şekil varsa [Şekil: kısa açıklama] yaz. Başka hiçbir yorum ekleme.",
            },
            { type: "image_url", image_url: { url: body.image } },
          ],
        },
      ],
    }),
  }).catch(() => undefined);
  if (!res?.ok) return json({ error: res?.status === 429 ? "rate-limit" : "upstream" }, res?.status === 429 ? 429 : 502);
  const out = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json({ text: (out.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim() });
}

/** Ders asistanı, Groq yolu: tarayıcı materyallerden ilgili alıntıları (context) gönderir. */
async function studyGroq(env: Env, body: StudyBody): Promise<Response> {
  const msgs = (body.messages ?? []).slice(-8);
  const last = msgs[msgs.length - 1];
  const system = `${body.system ?? ""}${body.context ? `\n\nMATERYAL ALINTILARI (kullanıcının dosyalarından; cevaplarken bunlara dayan, kaynağı belirt):\n${body.context}` : ""}`;
  const hasImage = Boolean(last?.image);
  const messages: ChatMsg[] = [
    { role: "system", content: system },
    ...msgs.map((m, i): ChatMsg => {
      const text = String(m.text ?? "");
      if (i === msgs.length - 1 && m.image)
        return { role: "user", content: [{ type: "text", text: text || "Bu görseldeki soruyu çöz." }, { type: "image_url", image_url: { url: m.image } }] };
      return { role: m.role === "assistant" ? "assistant" : "user", content: text };
    }),
  ];
  const tools = !hasImage && Array.isArray(body.tools) && body.tools.length ? body.tools.slice(0, 5) : undefined;
  return groqStream(env, {
    model: hasImage ? GROQ_VISION : GROQ_CHAT,
    messages,
    temperature: 0.4,
    max_tokens: 1800,
    ...(hasImage ? { reasoning_effort: "none" } : { reasoning_effort: "low" }),
    ...(tools ? { tools, tool_choice: "auto" } : {}),
  });
}

// ---------- Gemini ----------

type StudyBody = {
  system?: string;
  context?: string;
  messages?: { role: "user" | "assistant"; text?: string; image?: string; files?: { uri: string; mimeType: string }[] }[];
  tools?: { function?: { name: string; description?: string; parameters?: unknown } }[];
};

/** JSON Schema → Gemini şeması: "type" büyük harf, desteklenmeyen alanlar atılır. */
function toSchema(s: unknown): unknown {
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
    else if (k === "properties" && v && typeof v === "object")
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toSchema(pv)]));
    else if (k === "items") out.items = toSchema(v);
    else if (["description", "enum", "required", "minimum", "maximum", "nullable", "format"].includes(k)) out[k] = v;
  }
  return out;
}

let modelList: Promise<string[]> | undefined;
/** Denenecek modeller sırayla: GEMINI_MODEL → flash-latest → en yeni 3 sade flash → flash-lite-latest. */
function geminiModels(env: Env, key: string): Promise<string[]> {
  modelList ??= (async () => {
    const res = await fetch(`${GEMINI}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    const { models = [] } = res.ok ? ((await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }) : {};
    const version = (n: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0);
    const flash = models
      .map((m) => ({ id: m.name.replace(/^models\//, ""), ok: (m.supportedGenerationMethods ?? []).includes("generateContent") }))
      .filter((m) => m.ok && /^gemini-[\d.]+-flash$/.test(m.id))
      .sort((a, b) => version(b.id) - version(a.id))
      .slice(0, 3)
      .map((m) => m.id);
    const wanted = env.get("GEMINI_MODEL")?.replace(/^models\//, "");
    return [...(wanted ? [wanted] : []), "gemini-flash-latest", ...flash, "gemini-flash-lite-latest"].filter(
      (id, i, all) => all.indexOf(id) === i,
    );
  })().catch((err) => {
    modelList = undefined;
    throw err;
  });
  return modelList;
}

async function studyGemini(env: Env, body: StudyBody): Promise<Response> {
  const key = env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "not-configured" }, 503);
  const contents = (body.messages ?? []).slice(-16).map((m) => {
    const parts: Record<string, unknown>[] = [];
    for (const f of m.files ?? []) parts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
    const img = m.image ? /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(m.image) : null;
    if (img) parts.push({ inlineData: { mimeType: img[1], data: img[2] } });
    parts.push({ text: String(m.text || (img ? "Bu görseldeki soruyu çöz." : "")) });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const functionDeclarations = (body.tools ?? [])
    .slice(0, 5)
    .filter((t) => t.function?.name)
    .map((t) => ({ name: t.function!.name, description: t.function!.description ?? "", parameters: toSchema(t.function!.parameters) }));
  const payload = JSON.stringify({
    systemInstruction: body.system ? { parts: [{ text: body.system }] } : undefined,
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
    ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
  });

  // Yoğunlukta (503/429/cevapsız) sıradaki modele geç.
  let upstream: Response | undefined;
  let text = "";
  for (const model of await geminiModels(env, key)) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25_000);
    upstream = await fetch(`${GEMINI}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: payload,
      signal: abort.signal,
    }).catch(() => undefined);
    clearTimeout(timer);
    if (!upstream) continue;
    if (upstream.ok && upstream.body) break;
    text = await upstream.text().catch(() => "");
    console.warn("[gazzla-ai] gemini", model, upstream.status, text.slice(0, 200));
    const busy = [429, 500, 503].includes(upstream.status) || (upstream.status === 404 && !/file/i.test(text));
    if (!busy) break;
  }
  if (!upstream) return json({ error: "network" }, 502);
  if (!upstream.ok || !upstream.body) {
    if (upstream.status === 429) return json({ error: "rate-limit" }, 429);
    if (/file|uri/i.test(text) && [400, 403, 404].includes(upstream.status)) return json({ error: "file-expired" }, 410);
    return json({ error: "upstream" }, 502);
  }
  return sseToNdjson(upstream, (data, out) => {
    const parts = (data as { candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name: string; args?: unknown } }[] } }[] })
      .candidates?.[0]?.content?.parts;
    for (const p of parts ?? []) {
      if (p.functionCall?.name) out({ tool: p.functionCall.name, args: JSON.stringify(p.functionCall.args ?? {}) });
      else if (p.text && !p.thought) out({ text: p.text });
    }
  });
}

/** Dosyayı Gemini'nin dosya deposuna yükler (~48 saat kalır). Dosyanın adı gönderilmez. */
async function upload(env: Env, req: Request): Promise<Response> {
  const key = env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "not-configured" }, 503);
  const data = await req.arrayBuffer();
  if (data.byteLength > 50 * 1024 * 1024) return json({ error: "too-big" }, 413);
  const mimeType = (req.headers.get("content-type") || "application/octet-stream").split(";")[0];
  try {
    const start = await fetch(`${GEMINI}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(data.byteLength),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "gazzla-materyal" } }),
    });
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!start.ok || !uploadUrl) throw new Error(`start ${start.status}`);
    const put = await fetch(uploadUrl, {
      method: "POST",
      headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0" },
      body: data,
    });
    if (!put.ok) throw new Error(`upload ${put.status}`);
    let file = ((await put.json()) as { file: { name: string; uri: string; mimeType: string; state?: string; expirationTime?: string } }).file;
    for (let i = 0; i < 30 && file.state === "PROCESSING"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const check = await fetch(`${GEMINI}/v1beta/${file.name}`, { headers: { "x-goog-api-key": key } });
      if (check.ok) file = (await check.json()) as typeof file;
    }
    if (file.state === "FAILED") throw new Error("failed");
    return json({ uri: file.uri, mimeType: file.mimeType, expiresAt: file.expirationTime ? Date.parse(file.expirationTime) : Date.now() + 47 * 3600_000 });
  } catch (err) {
    console.warn("[gazzla-ai] upload", err);
    return json({ error: "upload" }, 502);
  }
}

// ---------- Giriş noktası ----------

export async function handle(req: Request, env: Env, opts: Opts = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";

  let userId = "dev";
  if (!opts.dev) {
    const id = await userIdOf(req, env);
    if (!id) return json({ error: "not-signed-in" }, 401);
    userId = id;
  }
  const country = opts.dev ? (env.get("DEV_COUNTRY") || "TR").toUpperCase() : await countryOf(req.headers.get("x-gazzla-geo"), env.get("GEO_SECRET"));
  const studyProvider = country && !RESTRICTED.has(country) ? "files" : "excerpts"; // files = Gemini, excerpts = Groq

  /** Günlük hakkı düşer; bittiyse 429 döner. */
  const spend = async (kind: Kind): Promise<Response | undefined> => {
    if (opts.dev) return undefined;
    try {
      return (await useOne(env, userId, kind)) ? undefined : json({ error: "daily-limit", kind }, 429);
    } catch (err) {
      console.warn("[gazzla-ai] usage", err);
      return json({ error: "upstream" }, 502);
    }
  };

  try {
    switch (route) {
      case "status": {
        const left = opts.dev ? { coach: 999, study: 999, ocr: 999 } : await leftToday(env, userId);
        return json({ study: studyProvider, country: country ?? null, left });
      }
      case "coach": {
        const stop = await spend("coach");
        return stop ?? coach(env, await req.json());
      }
      case "transcribe": {
        const stop = await spend("coach");
        return stop ?? transcribe(env, req);
      }
      case "study": {
        const stop = await spend("study");
        const body = (await req.json()) as StudyBody;
        return stop ?? (studyProvider === "files" ? studyGemini(env, body) : studyGroq(env, body));
      }
      case "upload":
        if (studyProvider !== "files") return json({ error: "wrong-region" }, 403);
        return upload(env, req);
      case "ocr": {
        const stop = await spend("ocr");
        return stop ?? ocr(env, await req.json());
      }
      default:
        return json({ error: "unknown-route" }, 404);
    }
  } catch (err) {
    console.warn("[gazzla-ai]", err);
    return json({ error: "upstream" }, 502);
  }
}

// Supabase'te (Deno) çalışırken sunucuyu başlat. Node'da (vite dev) bu satır atlanır.
// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D?.serve) D.serve((req: Request) => handle(req, { get: (n: string) => D.env.get(n) }));
