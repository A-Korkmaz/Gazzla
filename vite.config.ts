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
        try {
          messages = (JSON.parse(raw).messages as ChatMessage[])
            .filter((m) => typeof m.content === "string" && ["system", "user", "assistant"].includes(m.role))
            .slice(-30);
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
              reasoning_effort: "low", // kısa düşün, hızlı cevap ver
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
        // Biz her parçadan sadece yeni yazıyı alıp düz metin olarak aktarıyoruz.
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
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
              const text = JSON.parse(payload).choices?.[0]?.delta?.content;
              if (text) res.write(text);
            } catch {
              /* yarım satır olamaz (satır satır ayırdık); bozuk gelirse atla */
            }
          }
        }
        res.end();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Üçüncü değer "" → VITE_ ile başlamayan değişkenleri de oku. Bunlar tarayıcıya hiç gönderilmez.
  const env = loadEnv(mode, process.cwd(), "");
  return { plugins: [gazzlaAi(env.GROQ_API_KEY)] };
});
