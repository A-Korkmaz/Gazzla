// "Ders asistanı" modunun aracısı (yalnız `npm run dev` sırasında, vite.config.ts'ten bağlanır).
// Anahtar .env.local'de: GEMINI_API_KEY=... Tarayıcı servisin adını hiç görmez; sadece
//   POST /api/study/upload  → dosyayı servise yükler, { uri, mimeType, expiresAt } döner (dosya orada ~48 saat kalır)
//   POST /api/study         → sohbet; tarayıcıya satır satır JSON ({"text": "..."}) akıtır
// C++ benzetmesi: tarayıcı sadece bu iki fonksiyonun imzasını biliyor, içini (hangi servis) bilmiyor.

import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

const API = "https://generativelanguage.googleapis.com";

type Part = { text?: string; fileData?: { mimeType: string; fileUri: string }; inlineData?: { mimeType: string; data: string } };
type Content = { role: "user" | "model"; parts: Part[] };

function fail(res: ServerResponse, status: number, error: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error }));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Kullanılacak model. .env.local'de GEMINI_MODEL varsa o; yoksa servisin listesinden en yeni kararlı "flash"
 * modeli (hızlı ve ücretsiz katmanda en cömert olanı). Bir kez bulunup saklanır.
 */
let modelPromise: Promise<string> | undefined;
function pickModel(key: string, wanted: string | undefined): Promise<string> {
  if (wanted) return Promise.resolve(wanted.replace(/^models\//, ""));
  modelPromise ??= (async () => {
    const res = await fetch(`${API}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const { models = [] } = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const version = (n: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0);
    const candidates = models
      .map((m) => ({ id: m.name.replace(/^models\//, ""), methods: m.supportedGenerationMethods ?? [] }))
      .filter(
        (m) =>
          m.methods.includes("generateContent") &&
          /^gemini-[\d.]+-flash$/.test(m.id), // "-lite", "-preview", "-image", "-tts" vb. olmayan sade flash
      )
      .sort((a, b) => version(b.id) - version(a.id));
    const chosen = candidates[0]?.id ?? "gemini-flash-latest";
    console.log("[gazzla-study] model:", chosen);
    return chosen;
  })().catch((err) => {
    modelPromise = undefined; // bir dahakine yeniden dene
    throw err;
  });
  return modelPromise;
}

/** Dosyayı servisin "Files" deposuna yükler (iki adım: yer aç, sonra baytları gönder). */
async function uploadFile(key: string, data: Buffer, mimeType: string): Promise<{ uri: string; mimeType: string; expiresAt: number }> {
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(data.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "gazzla-materyal" } }), // dosyanın gerçek adı gönderilmiyor
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`upload-start ${start.status} ${await start.text().catch(() => "")}`);

  const put = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Length": String(data.length) },
    body: new Uint8Array(data),
  });
  if (!put.ok) throw new Error(`upload ${put.status} ${await put.text().catch(() => "")}`);
  let file = ((await put.json()) as { file: { name: string; uri: string; mimeType: string; state?: string; expirationTime?: string } }).file;

  // PDF'ler önce "PROCESSING" olur; hazır olana kadar (en fazla ~1 dk) bekle.
  for (let i = 0; i < 30 && file.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const check = await fetch(`${API}/v1beta/${file.name}`, { headers: { "x-goog-api-key": key } });
    if (check.ok) file = (await check.json()) as typeof file;
  }
  if (file.state === "FAILED") throw new Error("file-failed");
  const expiresAt = file.expirationTime ? Date.parse(file.expirationTime) : Date.now() + 47 * 3600_000;
  return { uri: file.uri, mimeType: file.mimeType, expiresAt };
}

export function studyRoutes(middlewares: Connect.Server, key: string | undefined, wantedModel: string | undefined): void {
  middlewares.use("/api/study/upload", async (req, res) => {
    if (req.method !== "POST") return fail(res, 405, "method");
    if (!key) return fail(res, 503, "no-study-key");
    const body = await readBody(req, 50 * 1024 * 1024);
    if (!body) return fail(res, 413, "too-big");
    const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
    try {
      const out = await uploadFile(key, body, mimeType);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
    } catch (err) {
      console.warn("[gazzla-study]", err);
      fail(res, 502, "upload");
    }
  });

  middlewares.use("/api/study", async (req, res) => {
    if (req.method !== "POST") return fail(res, 405, "method");
    if (!key) return fail(res, 503, "no-study-key");
    const raw = await readBody(req, 25 * 1024 * 1024);
    if (!raw) return fail(res, 413, "too-big");

    let system = "";
    let contents: Content[];
    try {
      const body = JSON.parse(raw.toString("utf8")) as {
        system?: string;
        messages: { role: "user" | "assistant"; text: string; files?: { uri: string; mimeType: string }[]; image?: string }[];
      };
      system = String(body.system ?? "");
      contents = body.messages.slice(-16).map((m) => {
        const parts: Part[] = [];
        for (const f of m.files ?? []) parts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
        const img = m.image ? /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(m.image) : null;
        if (img) parts.push({ inlineData: { mimeType: img[1], data: img[2] } });
        parts.push({ text: String(m.text || (img ? "Bu görseldeki soruyu çöz." : "")) });
        return { role: m.role === "assistant" ? "model" : "user", parts };
      });
    } catch {
      return fail(res, 400, "bad-json");
    }

    let model: string;
    try {
      model = await pickModel(key, wantedModel);
    } catch (err) {
      console.warn("[gazzla-study]", err);
      return fail(res, 502, "upstream");
    }

    const upstream = await fetch(`${API}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      }),
    }).catch(() => undefined);
    if (!upstream) return fail(res, 502, "network");
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      console.warn("[gazzla-study]", upstream.status, text.slice(0, 500));
      if (upstream.status === 429) return fail(res, 429, "rate-limit");
      // Yüklenen dosyanın süresi dolmuşsa tarayıcı yeniden yükleyip tekrar dener.
      if (/file|uri/i.test(text) && (upstream.status === 400 || upstream.status === 403 || upstream.status === 404))
        return fail(res, 410, "file-expired");
      return fail(res, 502, "upstream");
    }

    // Servisin SSE akışından sadece yazıyı alıp {"text": "..."} satırları olarak aktar.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";
    const handle = (line: string) => {
      const data = line.trim();
      if (!data.startsWith("data:")) return;
      try {
        const json = JSON.parse(data.slice(5).trim()) as {
          candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
        };
        for (const p of json.candidates?.[0]?.content?.parts ?? [])
          if (p.text && !p.thought) res.write(JSON.stringify({ text: p.text }) + "\n");
      } catch {
        /* bozuk satırı atla */
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(handle);
    }
    handle(buffer);
    res.end();
  });
}
