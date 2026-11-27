// "Gazzla AI" sayfası: kullanıcının çalışma verilerini bilen küçük bir sohbet asistanı.
// Şimdilik yalnız localhost'ta (`npm run dev`): istekler vite.config.ts'teki /api/ai aracısına gider,
// anahtar orada eklenir. Derlenmiş sitede (Netlify) menüde görünmez.
//
// main.ts'teki ortak şeyleri bir "ctx" nesnesiyle alıyoruz (timetableView.ts'teki gibi).

import { escapeHtml } from "./util";

export interface AssistantCtx {
  app: HTMLElement;
  headerHtml: () => string;
  pageHeadHtml: (kicker: string, title: string, sub?: string) => string;
  rerender: () => void; // main.ts'teki render() (üst çubuğun düğmelerini de bağlar)
  /** Kullanıcının o anki verileri (süreler, hedefler, projeler, bugünkü program) düz metin olarak. */
  contextText: () => string;
}

type Msg = { role: "user" | "assistant"; content: string; error?: boolean };

// Sohbet yalnız sayfa açık kaldığı sürece tutulur (kaydedilmez). C++'taki global bir std::vector<Msg> gibi.
const history: Msg[] = [];
let busy = false;

const SUGGESTIONS = ["Bugün ne çalışayım?", "Haftamı değerlendir", "Motivasyonum düştü", "Bana bir çalışma planı yap"];

function systemPrompt(ctx: AssistantCtx): string {
  return [
    "Sen Gazzla AI'sın: Gazzla adlı çalışma zamanlayıcısının yapay zeka asistanı.",
    "Kullanıcıya Türkçe, samimi, kısa ve gaz veren bir dille çalışma koçluğu yap: plan, motivasyon, odak, çalışma teknikleri.",
    "Cevapların kısa olsun (genelde birkaç cümle ya da kısa bir liste). Emoji az kullan.",
    "Hangi şirketin ya da hangi dil modelinin olduğunu asla söyleme, tahmin de ettirme. Sorulursa sadece",
    "\"Ben Gazzla AI'yım, Gazzla'nın yapay zeka asistanıyım\" de.",
    "Marka adı her zaman \"Gazzla\" (iki z). Uygulamada \"ders\" yerine \"proje\" deniyor.",
    "Kullanıcının uygulamadaki güncel verileri aşağıda. Gerektiğinde kullan, veri uydurma.",
    "",
    ctx.contextText(),
  ].join("\n");
}

/** Asistan cevabını güvenli HTML'e çevirir: önce kaçış, sonra **kalın** ve satır sonları. */
function formatText(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");
}

function bubbleHtml(m: Msg, i: number): string {
  const body = m.content ? formatText(m.content) : `<span class="ai-typing"><i></i><i></i><i></i></span>`;
  return `<div class="ai-msg ${m.role} ${m.error ? "error" : ""}" data-i="${i}">${body}</div>`;
}

function messagesHtml(): string {
  if (history.length === 0)
    return `
      <div class="ai-empty">
        <p class="muted">Çalışmanla ilgili ne istersen sor. Sürelerini, hedeflerini ve programını biliyorum.</p>
        <div class="ai-suggest">
          ${SUGGESTIONS.map((s) => `<button class="small ghost" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
        </div>
      </div>`;
  return history.map(bubbleHtml).join("");
}

export function renderAssistant(ctx: AssistantCtx): void {
  ctx.app.innerHTML = `
    ${ctx.headerHtml()}
    ${ctx.pageHeadHtml("Yapay zeka asistanı", `<span class="grad-text">Gazzla AI</span>`, "Plan, motivasyon, odak. Sor, gazlasın.")}
    <section class="card ai-chat">
      <div id="ai-messages" class="ai-messages">${messagesHtml()}</div>
      <form id="ai-form" class="ai-form">
        <textarea id="ai-input" rows="1" placeholder="Gazzla AI'ya yaz..." ${busy ? "disabled" : ""}></textarea>
        <button class="primary ai-send" type="submit" ${busy ? "disabled" : ""} aria-label="Gönder">Gönder</button>
      </form>
      ${history.length ? `<button class="small ghost ai-clear" id="ai-clear" ${busy ? "disabled" : ""}>Sohbeti temizle</button>` : ""}
    </section>`;

  const list = ctx.app.querySelector<HTMLElement>("#ai-messages")!;
  list.scrollTop = list.scrollHeight;
  const input = ctx.app.querySelector<HTMLTextAreaElement>("#ai-input")!;
  if (!busy) input.focus();

  // Kutu yazdıkça uzasın (en fazla birkaç satır); Enter gönderir, Shift+Enter yeni satır.
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(ctx, input.value);
    }
  });
  ctx.app.querySelector("#ai-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    send(ctx, input.value);
  });
  ctx.app.querySelectorAll<HTMLButtonElement>("[data-suggest]").forEach((b) =>
    b.addEventListener("click", () => send(ctx, b.dataset.suggest!)),
  );
  ctx.app.querySelector("#ai-clear")?.addEventListener("click", () => {
    history.length = 0;
    ctx.rerender();
  });
}

/** Son cevabın balonunu yeniden çizer (sayfa hâlâ açıksa). Her parça gelişinde çağrılır. */
function updateLast(): void {
  const list = document.querySelector<HTMLElement>("#ai-messages");
  if (!list) return; // kullanıcı başka sayfaya geçti; geçmiş yine güncelleniyor
  const i = history.length - 1;
  const el = list.querySelector<HTMLElement>(`.ai-msg[data-i="${i}"]`);
  if (!el) return;
  el.outerHTML = bubbleHtml(history[i], i);
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

const ERRORS: Record<string, string> = {
  "no-key": "Asistan henüz kurulmamış: .env.local dosyasına anahtar eklenip npm run dev yeniden başlatılmalı.",
  "rate-limit": "Biraz fazla hızlı gittik. Bir dakika sonra tekrar dene.",
};

async function send(ctx: AssistantCtx, text: string): Promise<void> {
  const content = text.trim();
  if (!content || busy) return;
  busy = true;
  history.push({ role: "user", content });
  const answer: Msg = { role: "assistant", content: "" };
  history.push(answer);
  if (document.querySelector("#ai-messages")) ctx.rerender();

  try {
    const messages = [
      { role: "system", content: systemPrompt(ctx) },
      ...history.filter((m) => m !== answer && !m.error).slice(-20).map(({ role, content }) => ({ role, content })),
    ];
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!res.ok || !res.body) {
      const code = await res.json().then((j) => j.error as string).catch(() => "");
      throw new Error(ERRORS[code] ?? "Gazzla AI'ya şu an ulaşılamıyor. Biraz sonra tekrar dene.");
    }
    // Cevap parça parça geliyor; her parçayı ekleyip balonu yeniliyoruz.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      answer.content += decoder.decode(value, { stream: true });
      updateLast();
    }
    if (!answer.content) throw new Error("Boş cevap geldi. Tekrar dener misin?");
  } catch (err) {
    answer.error = true;
    answer.content = err instanceof Error && err.message ? err.message : "Bir şeyler ters gitti.";
  } finally {
    busy = false;
    if (document.querySelector("#ai-messages")) ctx.rerender();
  }
}
