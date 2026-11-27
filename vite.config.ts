// Vite ayarı. Tek ek iş: `npm run dev` sırasında Gazzla AI'nin sunucu tarafını yerelde çalıştırmak.
//
// Canlı sitede Gazzla AI, Supabase'teki "gazzla-ai" fonksiyonunda çalışıyor
// (supabase/functions/gazzla-ai/index.ts). Geliştirirken her değişikliği Supabase'e yüklemek zahmetli
// olduğu için AYNI dosyayı burada da çağırıyoruz: tarayıcı localhost:5173/api/gazzla-ai/... adresine sorar,
// bu dosya isteği o fonksiyona verir. C++ benzetmesi: aynı fonksiyonu iki farklı main() içinden çağırmak.
//
// Yerelde giriş ve günlük hak kontrolü yok. Anahtarlar `.env.local`'de (GROQ_API_KEY, GEMINI_API_KEY;
// bu dosya .gitignore'da). Ülke DEV_COUNTRY ile seçilir (varsayılan TR = Gemini; CH yazarsan Groq yolu denenir).

import { defineConfig, loadEnv, type Plugin } from "vite";
import { Readable } from "node:stream";
import { handle } from "./supabase/functions/gazzla-ai/index";

function gazzlaAiDev(env: Record<string, string>): Plugin {
  return {
    name: "gazzla-ai-dev",
    apply: "serve", // yalnız geliştirme sunucusunda; derlenmiş siteye girmez
    configureServer(server) {
      server.middlewares.use("/api/gazzla-ai", async (req, res) => {
        // Node'un isteğini web standardı Request'e çevir, fonksiyona ver, cevabı geri akıt.
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const request = new Request(`http://localhost/api/gazzla-ai${req.url ?? ""}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
        });
        const response = await handle(request, { get: (n) => env[n] }, { dev: true });
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        if (response.body) Readable.fromWeb(response.body as never).pipe(res);
        else res.end();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Üçüncü değer "" → VITE_ ile başlamayan değişkenleri de oku. Bunlar tarayıcıya hiç gönderilmez.
  const env = loadEnv(mode, process.cwd(), "");
  return { plugins: [gazzlaAiDev(env)] };
});
