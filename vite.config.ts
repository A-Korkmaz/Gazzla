// Vite ayarı. Tek ek iş: "Gazzla AI" asistanı için küçük bir aracı (yalnız `npm run dev` sırasında).
//
// Neden aracı? Yapay zeka servisinin anahtarı tarayıcıya giderse siteyi açan herkes görebilir.
// C++ benzetmesi: şifreyi koda gömüp .exe'yi dağıtmak gibi. Bu yüzden tarayıcı sadece
// localhost:5173/api/ai adresine soruyor; anahtarı bu dosya (Node tarafında) ekleyip isteği iletiyor
// ve cevabın sadece yazı kısmını geri gönderiyor (servisin/modelin adı tarayıcıya hiç gitmez).
// Anahtar `.env.local` dosyasında: GROQ_API_KEY=... (bu dosya .gitignore'da, GitHub'a gitmez).

import { defineConfig, loadEnv, type Plugin } from "vite";

const AI_URL = "https://api.groq.com/openai/v1/chat/completions";
const AI_MODEL = "openai/gpt-oss-120b"; // listeyi görmek için: GET https://api.groq.com/openai/v1/models

const TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const TRANSCRIBE_MODEL = "whisper-large-v3-turbo"; // ses → yazı, dili kendisi anlıyor

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function gazzlaAi(key: string | undefined): Plugin {
  return {
    name: "gazzla-ai",
    apply: "serve", // yalnız geliştirme sunucusunda; derlenmiş siteye girmez
    configureServer(server) {
      server.middlewares.use("/api/ai", async (req, res) => {
        const fail = (status: number, error: string) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error }));
        };
        if (req.method !== "POST") return fail(405, "method");
        if (!key) return fail(503, "no-key");

        let raw = "";
        for await (const chunk of req) raw += chunk;
        let messages: ChatMessage[];
        let tools: unknown[] | undefined;
        try {
          const body = JSON.parse(raw);
          messages = (body.messages as ChatMessage[])
            .filter((m) => typeof m.content === "string" && ["system", "user", "assistant"].includes(m.role))
            .slice(-30);
          // Araçlar (ör. "programa blok öner"): tanımları assistant.ts'te; burada olduğu gibi iletiyoruz.
          if (Array.isArray(body.tools) && body.tools.length) tools = body.tools.slice(0, 5);
        } catch {
          return fail(400, "bad-json");
        }

        let upstream: Response;
        try {
          upstream = await fetch(AI_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: AI_MODEL,
              messages,
              stream: true,
              temperature: 0.7,
              max_tokens: 2048, // düşünme payı da buna dahil
              // Araçlı isteklerde biraz daha düşünsün (gün/saat eşlemesi doğru olsun); yoksa kısa düşün, hızlı cevap ver.
              reasoning_effort: tools ? "medium" : "low",
              ...(tools ? { tools, tool_choice: "auto" } : {}),
            }),
          });
        } catch {
          return fail(502, "network");
        }
        if (!upstream.ok || !upstream.body) {
          console.warn("[gazzla-ai]", upstream.status, await upstream.text().catch(() => ""));
          return fail(502, upstream.status === 429 ? "rate-limit" : "upstream");
        }

        // Servis cevabı parça parça (SSE) gönderiyor: "data: {...}" satırları.
        // Biz tarayıcıya kendi sade biçimimizde, satır satır JSON yolluyoruz (NDJSON):
        //   {"text":"..."}                      → cevaba eklenecek yazı
        //   {"tool":"ad","args":"{...json...}"} → model bir araç çağırdı (en sonda, tamamlanmış hâliyle)
        // Araç çağrısının argümanları da parça parça geliyor; sırasına (index) göre birleştiriyoruz.
        // C++ benzetmesi: std::map<int, std::string> içine += ile ekleme.
        const toolCalls = new Map<number, { name: string; args: string }>();
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        const decoder = new TextDecoder();
        let buffer = "";
        const reader = upstream.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const data = line.trim();
            if (!data.startsWith("data:")) continue;
            const payload = data.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const delta = JSON.parse(payload).choices?.[0]?.delta;
              if (delta?.content) res.write(JSON.stringify({ text: delta.content }) + "\n");
              for (const tc of delta?.tool_calls ?? []) {
                const cur = toolCalls.get(tc.index ?? 0) ?? { name: "", args: "" };
                if (tc.function?.name) cur.name += tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                toolCalls.set(tc.index ?? 0, cur);
              }
            } catch {
              /* yarım satır olamaz (satır satır ayırdık); bozuk gelirse atla */
            }
          }
        }
        for (const tc of toolCalls.values()) res.write(JSON.stringify({ tool: tc.name, args: tc.args }) + "\n");
        res.end();
      });

      // Ses kaydı → yazı. Tarayıcı kaydı ham olarak (ör. audio/webm) gönderiyor; biz form olarak iletiyoruz.
      server.middlewares.use("/api/transcribe", async (req, res) => {
        const fail = (status: number, error: string) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error }));
        };
        if (req.method !== "POST") return fail(405, "method");
        if (!key) return fail(503, "no-key");

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) return fail(413, "too-big"); // ~20 MB, birkaç dakikalık kayıt
          chunks.push(chunk as Buffer);
        }
        const type = String(req.headers["content-type"] || "audio/webm").split(";")[0];
        const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
        const form = new FormData();
        form.append("file", new Blob([Buffer.concat(chunks)], { type }), `kayit.${ext}`);
        form.append("model", TRANSCRIBE_MODEL);
        form.append("response_format", "json");

        try {
          const upstream = await fetch(TRANSCRIBE_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: form,
          });
          if (!upstream.ok) {
            console.warn("[gazzla-ai] ses", upstream.status, await upstream.text().catch(() => ""));
            return fail(502, upstream.status === 429 ? "rate-limit" : "upstream");
          }
          const { text } = (await upstream.json()) as { text?: string };
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ text: (text ?? "").trim() }));
        } catch {
          return fail(502, "network");
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Üçüncü değer "" → VITE_ ile başlamayan değişkenleri de oku. Bunlar tarayıcıya hiç gönderilmez.
  const env = loadEnv(mode, process.cwd(), "");
  return { plugins: [gazzlaAi(env.GROQ_API_KEY)] };
});
