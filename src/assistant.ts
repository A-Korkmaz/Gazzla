// "Gazzla AI" sayfası: kullanıcının çalışma verilerini bilen küçük bir sohbet asistanı.
// Şimdilik yalnız localhost'ta (`npm run dev`): istekler vite.config.ts'teki /api/ai ve /api/transcribe
// aracılarına gider, anahtar orada eklenir. Derlenmiş sitede (Netlify) menüde görünmez.
//
// İki mod var: "Koç" (Groq, vite.config.ts) ve "Ders asistanı" (Gemini, server/gemini.ts; materyaller study.ts'te).
// Koç modu üç iş yapıyor:
//   1. Sohbet (cevap parça parça gelir).
//   2. Programa blok önerme: model "program_oner" aracını çağırır, biz bir önizleme kartı gösteririz;
//      kullanıcı "Programa ekle" demeden hiçbir şey eklenmez.
//   3. Sesli sohbet: mikrofon kaydı yazıya çevrilir (sessizlik olunca kendiliğinden durur),
//      cevap tarayıcının Türkçe sesiyle okunur, sonra tekrar dinlemeye başlar.
//
// main.ts'teki ortak şeyleri bir "ctx" nesnesiyle alıyoruz (timetableView.ts'teki gibi).

import { toast } from "./effects";
import {
  ACCEPT,
  addMaterial,
  ensureUploaded,
  imageToDataUrl,
  isUploading,
  loadMaterials,
  materialsNow,
  MAX_SIZE,
  removeMaterial,
  setActive,
  sizeText,
} from "./study";
import { dayKey, loadSubjects } from "./storage";
import { DAY_NAMES, putBlock, weekdayOf, type Block } from "./timetable";
import { clockText, escapeHtml } from "./util";

export interface AssistantCtx {
  app: HTMLElement;
  headerHtml: () => string;
  pageHeadHtml: (kicker: string, title: string, sub?: string) => string;
  rerender: () => void; // main.ts'teki render() (üst çubuğun düğmelerini de bağlar)
  changed: () => void; // program değişti: buluta ve Google'a eşitle
  openTimetable: () => void; // Program sayfasına geç
  /** Kullanıcının o anki verileri (süreler, hedefler, projeler, bugünkü program) düz metin olarak. */
  contextText: () => string;
}

interface Proposal {
  blocks: Block[];
  skipped: number; // anlaşılamayan (saati bozuk vb.) öneri sayısı
  status: "pending" | "added" | "cancelled";
}

type Msg = {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  proposal?: Proposal; // koç: programa ekleme önerisi
  image?: string; // ders asistanı: kullanıcının eklediği fotoğraf (data URL)
  note?: string; // cevap gelene kadar gösterilen küçük not ("materyaller okunuyor...")
};

// İki mod, Claude'daki model seçici gibi: "Koç" (hızlı sohbet, program, ses) ve "Ders asistanı"
// (materyaller, sınav çözme). Her modun kendi sohbeti var.
type Mode = "coach" | "study";
const MODE_KEY = "gazzla.aiMode";
let mode: Mode = (() => {
  try {
    return localStorage.getItem(MODE_KEY) === "study" ? "study" : "coach";
  } catch {
    return "coach";
  }
})();

// Sohbet yalnız sayfa açık kaldığı sürece tutulur (kaydedilmez). C++'taki global bir std::vector<Msg> gibi.
const histories: Record<Mode, Msg[]> = { coach: [], study: [] };
const hist = () => histories[mode];
let busy = false;
let pendingImage: string | undefined; // ders asistanı: bir sonraki mesajla gidecek fotoğraf
let matsOpen = true; // materyal listesi açık mı

const SUGGESTIONS = [
  "Bugün ne çalışayım?",
  "Haftamı değerlendir",
  "Programıma bir şey ekle",
  "Motivasyonum düştü",
];

const STUDY_SUGGESTIONS = [
  "Bu materyali kısaca özetle",
  "En önemli kavramları açıkla",
  "İlk soruyu adım adım çöz",
  "Bana bu konudan 3 soru sor",
];

// ---------- Modelin bilgisi ----------

/** Önümüzdeki 14 gün, "2026-11-27 Cuma" gibi. Model tarihleri karıştırmasın diye hazır veriyoruz. */
function upcomingDays(): string {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 14; i++) {
    out.push(`${dayKey(d)} ${DAY_NAMES[weekdayOf(d)]}${i === 0 ? " (bugün)" : i === 1 ? " (yarın)" : ""}`);
    d.setDate(d.getDate() + 1);
  }
  return out.join(", ");
}

function systemPrompt(ctx: AssistantCtx): string {
  return [
    "Sen Gazzla AI'sın: Gazzla adlı çalışma zamanlayıcısının yapay zeka asistanı.",
    "Kullanıcıya Türkçe, samimi, kısa ve gaz veren bir dille çalışma koçluğu yap: plan, motivasyon, odak, çalışma teknikleri.",
    "Cevapların kısa olsun (genelde birkaç cümle ya da kısa bir liste). Tablo kullanma. Emoji az kullan.",
    "Hangi şirketin ya da hangi dil modelinin olduğunu asla söyleme, tahmin de ettirme. Sorulursa sadece",
    "\"Ben Gazzla AI'yım, Gazzla'nın yapay zeka asistanıyım\" de.",
    "Marka adı her zaman \"Gazzla\" (iki z). Uygulamada \"ders\" yerine \"proje\" deniyor.",
    "",
    "PROGRAM: Kullanıcı ders, sunum, sınav, etkinlik ya da çalışma saati anlatıp programına eklemek isterse",
    "(ya da senden çalışma planı isteyip kabul ederse) program_oner aracını çağır. Kurallar:",
    "- Sunum, sınav, ders, toplantı gibi şeyler kind=\"fixed\", title ile (ör. \"Analysis sunumu\").",
    "  Sabit bloklar için proje GEREKMEZ; proje oluşturmayı sorma, doğrudan aracı çağır.",
    "- Bir mesajda birden fazla blok varsa HEPSİNİ tek bir program_oner çağrısında ver, hiçbirini atlama.",
    "- kind=\"study\" SADECE aşağıdaki proje listesinde AYNEN olan bir proje için; project alanına o adı yaz.",
    "  Listede olmayan bir çalışma isteğini de ATLAMA: fixed olarak ekle (ör. title \"Kütüphane çalışması\") ve",
    "  cevabında, o adla bir proje oluşturursa çalışmanın süresine sayılacağını tek cümleyle söyle.",
    "- Her blok için weekday ver (0=pazartesi, 1=salı, 2=çarşamba, 3=perşembe, 4=cuma, 5=cumartesi, 6=pazar).",
    "  Kullanıcının söylediği günü aynen çevir; her blok kendi gününü alır, karıştırma.",
    "  repeat=true SADECE kullanıcı \"her\", \"her hafta\", \"haftalık\" gibi tekrar belirtirse; yoksa repeat=false.",
    "  Her hafta tekrar ediyorsa repeat=true. Tek seferlikse repeat=false; tarih o günün önümüzdeki ilk tarihi olur.",
    "  Sadece 7 günden daha ileri bir tarih söylenmişse (ör. \"15 aralık\", \"haftaya salı\") date (YYYY-MM-DD) da ver.",
    "- Saatler 24 saatlik HH:MM. Bitiş saati söylenmediyse makul bir süre seç (ders/sunum 1 saat gibi) ve bunu söyle.",
    "- Gün ya da saat belirsizse aracı çağırmadan önce kısaca sor.",
    "- Aracı çağırdıktan sonra tek kısa cümle yaz; kullanıcı ekranda çıkan karttan onaylayacak. Blokları metinde tekrar sayma.",
    `Tarihler: ${upcomingDays()}.`,
    "",
    "Kullanıcının uygulamadaki güncel verileri aşağıda. Gerektiğinde kullan, veri uydurma.",
    ctx.contextText(),
  ].join("\n");
}

/** Modele gösterdiğimiz araç: "şu blokları programa eklemeyi öner". Parametreleri JSON Schema ile tarif ediliyor. */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "program_oner",
      description:
        "Kullanıcının programına (haftalık takvim) eklenmek üzere blok önerir. Kullanıcı ekrandaki karttan onaylamadan hiçbir şey eklenmez.",
      parameters: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["study", "fixed"], description: "study: mevcut bir projeye çalışma; fixed: ders, sunum, sınav, etkinlik" },
                title: { type: "string", description: "fixed için ad, ör. 'Analysis sunumu'" },
                project: { type: "string", description: "study için proje adı, listeden aynen" },
                weekday: { type: "integer", minimum: 0, maximum: 6, description: "Gün: 0=pazartesi, 1=salı, 2=çarşamba, 3=perşembe, 4=cuma, 5=cumartesi, 6=pazar" },
                repeat: { type: "boolean", description: "Her hafta tekrar ediyorsa true, tek seferlikse false" },
                date: { type: "string", description: "Yalnız 7 günden ileri tek seferlik bloklar için: YYYY-MM-DD" },
                start: { type: "string", description: "Başlangıç, HH:MM" },
                end: { type: "string", description: "Bitiş, HH:MM" },
              },
              required: ["kind", "weekday", "repeat", "start", "end"],
            },
          },
        },
        required: ["blocks"],
      },
    },
  },
];

// ---------- Öneriyi Block'a çevirme ----------

/** "14:30" → 870 (gece yarısından beri dakika). "24:00" da olur. Bozuksa undefined. */
function parseClock(s: unknown): number | undefined {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return undefined;
  return h * 60 + min;
}

/**
 * Modelin önerdiği blokları kontrol edip Block'a çevirir. Ahmet'in kuralı: listede olmayan bir ad
 * asla projeye çevrilmez; "study" ama proje bilinmiyorsa sabit blok yapılır.
 */
function toProposal(argsJson: string): Proposal {
  let raw: unknown[] = [];
  try {
    const parsed = JSON.parse(argsJson);
    if (Array.isArray(parsed?.blocks)) raw = parsed.blocks;
  } catch {
    /* bozuk JSON: hiç blok yok sayılır */
  }
  const projects = loadSubjects();
  const findProject = (name: unknown) => {
    const t = String(name ?? "").trim().toLocaleLowerCase("tr");
    return t ? projects.find((p) => p.toLocaleLowerCase("tr") === t) : undefined;
  };

  const blocks: Block[] = [];
  let skipped = 0;
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    const start = parseClock(r.start);
    const end = parseClock(r.end);
    const weekday = Number.isInteger(r.weekday) && (r.weekday as number) >= 0 && (r.weekday as number) <= 6 ? (r.weekday as number) : undefined;
    const repeat = r.repeat === true;
    // Tek seferlik blokta tarihi biz hesaplıyoruz (model tarih hesabında karıştırabiliyor):
    // model 7 günden ileri bir tarih verdiyse ve gün adıyla tutuyorsa onu, yoksa o günün önümüzdeki ilk tarihini al.
    let date: string | undefined;
    if (!repeat) {
      const given = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : undefined;
      const givenDay = given ? weekdayOf(new Date(`${given}T12:00`)) : undefined;
      if (given && (weekday === undefined || givenDay === weekday) && given >= dayKey(new Date())) date = given;
      else if (weekday !== undefined && start !== undefined) date = nextDateOf(weekday, start);
    }
    if (start === undefined || end === undefined || end - start < 10 || weekday === undefined || (!repeat && !date)) {
      skipped++;
      continue;
    }
    const project = r.kind === "study" ? findProject(r.project ?? r.title) : undefined;
    const title = String(r.title ?? r.project ?? "").trim().slice(0, 80);
    if (!project && !title) {
      skipped++;
      continue;
    }
    blocks.push({
      id: crypto.randomUUID(),
      kind: project ? "study" : "fixed",
      subject: project,
      title: project ? undefined : title,
      date: date,
      weekday: repeat ? weekday : undefined,
      start,
      end,
      updatedAt: Date.now(),
    });
  }
  return { blocks, skipped, status: "pending" };
}

/** O haftagününün önümüzdeki ilk tarihi. Bugünse ve saat henüz geçmediyse bugün. */
function nextDateOf(weekday: number, startMin: number): string {
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  let add = (weekday - weekdayOf(d) + 7) % 7;
  if (add === 0 && startMin <= nowMin) add = 7;
  d.setDate(d.getDate() + add);
  return dayKey(d);
}

function whenText(b: Block): string {
  if (b.date) {
    const [y, m, d] = b.date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("tr-TR", { weekday: "short", day: "numeric", month: "short" });
  }
  return `Her ${DAY_NAMES[b.weekday ?? 0].toLocaleLowerCase("tr")}`;
}

function blockName(b: Block): string {
  return b.kind === "study" ? (b.subject ?? "Genel çalışma") : (b.title ?? "Etkinlik");
}

/** Öneriyi geçmişte modele hatırlatmak için kısa metin. */
function proposalSummary(p: Proposal): string {
  const list = p.blocks.map((b) => `${whenText(b)} ${clockText(b.start)}–${clockText(b.end)} ${blockName(b)}`).join("; ");
  const state = p.status === "added" ? "kullanıcı programa ekledi" : p.status === "cancelled" ? "kullanıcı vazgeçti" : "kullanıcı henüz onaylamadı";
  return `[Programa ekleme önerin: ${list || "geçerli blok yok"}. Durum: ${state}]`;
}

// ---------- Çizim ----------

/**
 * Asistan cevabını güvenli HTML'e çevirir: önce kaçış (escape), sonra biraz Markdown:
 * başlıklar kalın satır, "- " maddeler "• ", **kalın**, `kod`, satır sonları.
 */
function formatText(text: string): string {
  return escapeHtml(text)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function proposalHtml(p: Proposal, i: number): string {
  if (p.blocks.length === 0)
    return `<div class="ai-plan"><p class="muted">Öneriyi anlayamadım. Gün ve saatleri bir daha yazar mısın?</p></div>`;
  const items = p.blocks
    .map(
      (b) => `
        <li>
          <span class="ai-plan-when">${escapeHtml(whenText(b))} · ${clockText(b.start)}–${clockText(b.end)}</span>
          <span class="ai-plan-name">${escapeHtml(blockName(b))}</span>
          <span class="ai-plan-tag ${b.kind}">${b.kind === "study" ? "çalışma" : "sabit"}</span>
        </li>`,
    )
    .join("");
  const foot =
    p.status === "pending"
      ? `<div class="ai-plan-actions">
           <button class="small primary" data-add="${i}">Programa ekle (${p.blocks.length})</button>
           <button class="small ghost" data-cancel="${i}">Vazgeç</button>
         </div>`
      : p.status === "added"
        ? `<div class="ai-plan-actions"><span class="ai-plan-done">Programa eklendi</span>
             <button class="small ghost" data-open-tt>Programa git →</button></div>`
        : `<div class="ai-plan-actions"><span class="muted">Vazgeçildi</span></div>`;
  return `
    <div class="ai-plan ${p.status}">
      <div class="ai-plan-title">Programa eklenecek</div>
      <ul>${items}</ul>
      ${p.skipped ? `<p class="muted small-note">${p.skipped} öneri anlaşılamadığı için atlandı.</p>` : ""}
      ${foot}
    </div>`;
}

function bubbleHtml(m: Msg, i: number): string {
  const text = m.content ? formatText(m.content) : "";
  const typing = `<span class="ai-typing"><i></i><i></i><i></i></span>${m.note ? ` <span class="muted small-note">${escapeHtml(m.note)}</span>` : ""}`;
  const body = text || m.proposal ? text : typing;
  const img = m.image ? `<img class="ai-msg-img" src="${m.image}" alt="Eklenen görsel" />` : "";
  return `<div class="ai-msg ${m.role} ${m.error ? "error" : ""} ${m.proposal ? "has-plan" : ""}" data-i="${i}">
      ${img}${body}${m.proposal ? proposalHtml(m.proposal, i) : ""}
    </div>`;
}

function messagesHtml(): string {
  if (hist().length === 0) {
    const intro =
      mode === "coach"
        ? "Çalışmanla ilgili ne istersen sor ya da mikrofona bas, konuş. Sürelerini, hedeflerini ve programını biliyorum; programına ders, sınav, sunum da ekleyebilirim."
        : "Ders notunu, kitabını ya da eski sınavını yukarıdan ekle; anlamadığın her şeyi sor, sınavı adım adım çözdür. Soru fotoğrafını ataşla ekleyebilir ya da ekran görüntüsünü yapıştırabilirsin (Ctrl+V).";
    const list = mode === "coach" ? SUGGESTIONS : STUDY_SUGGESTIONS;
    return `
      <div class="ai-empty">
        <p class="muted">${intro}</p>
        <div class="ai-suggest">
          ${list.map((s) => `<button class="small ghost" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
        </div>
      </div>`;
  }
  return hist().map(bubbleHtml).join("");
}

// ---------- Materyal paneli (yalnız ders asistanı) ----------

function matsHtml(): string {
  const mats = materialsNow();
  if (!mats) {
    loadMaterials().then(refreshMats);
    return `<p class="muted small-note">Materyaller yükleniyor...</p>`;
  }
  const active = mats.filter((m) => m.active).length;
  const head = `
    <div class="ai-mats-head">
      <button type="button" class="ai-mats-toggle" data-mats-toggle aria-expanded="${matsOpen}">
        <span class="ico">${BOOK_ICON}</span>
        <b>Materyaller</b>
        <span class="muted">${mats.length ? `${active}/${mats.length} işaretli` : "henüz yok"}</span>
        <span class="ai-caret ${matsOpen ? "open" : ""}">▾</span>
      </button>
      <label class="small ghost ai-mats-add">+ Ekle<input type="file" id="ai-mat-file" accept="${ACCEPT}" multiple hidden /></label>
    </div>`;
  if (!matsOpen) return head;
  const rows = mats
    .map((m) => {
      const kind = m.mimeType === "application/pdf" ? "PDF" : m.mimeType.startsWith("image/") ? "IMG" : "TXT";
      const state = isUploading(m.id)
        ? "hazırlanıyor..."
        : m.remote && m.remote.expiresAt > Date.now()
          ? "hazır"
          : "";
      return `
        <li class="ai-mat ${m.active ? "" : "off"}">
          <label>
            <input type="checkbox" data-mat-active="${m.id}" ${m.active ? "checked" : ""} />
            <span class="ai-mat-kind">${kind}</span>
            <span class="ai-mat-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
          </label>
          <span class="muted ai-mat-meta">${sizeText(m.size)}${state ? ` · ${state}` : ""}</span>
          <button type="button" class="icon ai-mat-del" data-mat-del="${m.id}" title="Sil" aria-label="${escapeHtml(m.name)} sil">×</button>
        </li>`;
    })
    .join("");
  return `
    ${head}
    ${
      mats.length
        ? `<ul class="ai-mat-list">${rows}</ul>
           <p class="muted small-note">İşaretli materyaller her soruda okunur. Sadece o anki derse ait olanları işaretli tut, cevap hızlı gelsin.</p>`
        : `<p class="muted small-note">PDF (ders notu, kitap, eski sınav), metin ya da fotoğraf ekle. Dosyalar bu cihazda kalır.</p>`
    }`;
}

function refreshMats(): void {
  const el = document.querySelector<HTMLElement>("#ai-mats");
  if (el) el.innerHTML = matsHtml();
}

async function addFiles(files: FileList | File[]): Promise<void> {
  for (const file of Array.from(files)) {
    if (file.size > MAX_SIZE) {
      toast(`${file.name} çok büyük (en fazla 50 MB).`);
      continue;
    }
    const m = await addMaterial(file);
    refreshMats();
    ensureUploaded(m)
      .catch((err) => toast(ERRORS[err instanceof Error ? err.message : ""] ?? `${file.name} hazırlanamadı. Soru sorunca yeniden denerim.`))
      .finally(refreshMats);
    refreshMats(); // "hazırlanıyor..." görünsün
  }
}

/** Sohbete eklenecek fotoğrafın küçük önizlemesi (gönder deyince mesajla gider). */
function chipHtml(): string {
  return pendingImage
    ? `<div class="ai-chip"><img src="${pendingImage}" alt="Eklenecek görsel" /><button type="button" class="icon" data-chip-del aria-label="Görseli kaldır">×</button></div>`
    : "";
}

function refreshChip(): void {
  const el = document.querySelector<HTMLElement>("#ai-chip-wrap");
  if (el) el.innerHTML = chipHtml();
}

async function attachImage(file: Blob): Promise<void> {
  try {
    pendingImage = await imageToDataUrl(file);
    refreshChip();
  } catch {
    toast("Bu görsel açılamadı.");
  }
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const MIC_ICON = svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>');
const STOP_ICON = svg('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>');
const SPEAKER_ICON = svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>');
const BOLT_ICON = svg('<path d="M13 3 5 13.5h6L10.5 21 19 10h-6z"/>');
const BOOK_ICON = svg('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>');
const CLIP_ICON = svg('<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7-7L13 4.5a3.4 3.4 0 0 1 4.8 4.8l-7.7 7.7a1.7 1.7 0 0 1-2.4-2.4l7-7"/>');

export function renderAssistant(ctx: AssistantCtx): void {
  const study = mode === "study";
  const locked = busy || recState !== "idle";
  const modeBtn = (m: Mode, icon: string, label: string, note: string) => `
    <button type="button" class="ai-mode ${mode === m ? "on" : ""}" data-mode="${m}" role="tab"
      aria-selected="${mode === m}" ${locked && mode !== m ? "disabled" : ""}>
      <span class="ico">${icon}</span>
      <span class="ai-mode-text"><b>${label}</b><small>${note}</small></span>
    </button>`;

  ctx.app.innerHTML = `
    ${ctx.headerHtml()}
    ${ctx.pageHeadHtml(
      "Yapay zeka asistanı",
      `<span class="grad-text">Gazzla AI</span>`,
      study ? "Ders notların, kitapların, eski sınavların. Sor, çözdür, anla." : "Plan, motivasyon, odak. Sor, gazlasın.",
    )}
    <section class="card ai-chat">
      <div class="ai-modes" role="tablist" aria-label="Asistan">
        ${modeBtn("coach", BOLT_ICON, "Koç", "Plan, program, motivasyon")}
        ${modeBtn("study", BOOK_ICON, "Ders asistanı", "Materyallerin, sorular, sınavlar")}
      </div>
      ${study ? `<div id="ai-mats" class="ai-mats">${matsHtml()}</div>` : ""}
      <div class="ai-top">
        <button id="ai-voice" class="small ghost ai-voice ${voiceMode ? "on" : ""}" aria-pressed="${voiceMode}"
          title="Açıkken cevapları sesli okur ve okuyunca seni yeniden dinler">
          <span class="ico">${SPEAKER_ICON}</span> Sesli sohbet: ${voiceMode ? "açık" : "kapalı"}
        </button>
        ${hist().length ? `<button class="small ghost" id="ai-clear" ${busy ? "disabled" : ""}>Sohbeti temizle</button>` : ""}
      </div>
      <div id="ai-messages" class="ai-messages">${messagesHtml()}</div>
      ${study ? `<div id="ai-chip-wrap">${chipHtml()}</div>` : ""}
      <form id="ai-form" class="ai-form">
        <button type="button" id="ai-mic" class="ai-mic" aria-label="Sesle yaz">${MIC_ICON}</button>
        ${
          study
            ? `<label class="ai-attach" title="Fotoğraf ekle" aria-label="Fotoğraf ekle">${CLIP_ICON}<input type="file" id="ai-photo" accept="image/*" hidden /></label>`
            : ""
        }
        <textarea id="ai-input" rows="1" placeholder="Gazzla AI'ya yaz..." ${busy ? "disabled" : ""}></textarea>
        <button class="primary ai-send" type="submit" ${busy ? "disabled" : ""} aria-label="Gönder">Gönder</button>
      </form>
    </section>`;

  const list = ctx.app.querySelector<HTMLElement>("#ai-messages")!;
  list.scrollTop = list.scrollHeight;
  const input = ctx.app.querySelector<HTMLTextAreaElement>("#ai-input")!;
  if (!busy && recState === "idle") input.focus();
  updateMicUi();

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
  ctx.app.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      const m = b.dataset.mode as Mode;
      if (m === mode || busy || recState !== "idle") return;
      stopSpeaking();
      mode = m;
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        /* kaydedilemezse sorun değil */
      }
      ctx.rerender();
    }),
  );
  ctx.app.querySelector("#ai-clear")?.addEventListener("click", () => {
    stopSpeaking();
    hist().length = 0;
    pendingImage = undefined;
    ctx.rerender();
  });
  ctx.app.querySelector("#ai-mic")!.addEventListener("click", () => {
    if (recState === "rec") stopRec(false);
    else if (recState === "idle") startRec(ctx);
  });
  ctx.app.querySelector("#ai-voice")!.addEventListener("click", () => {
    voiceMode = !voiceMode;
    try {
      localStorage.setItem(VOICE_KEY, voiceMode ? "1" : "0");
    } catch {
      /* kaydedilemezse sorun değil */
    }
    if (!voiceMode) stopSpeaking();
    ctx.rerender();
  });

  if (study) {
    // Materyal paneli: içi sık sık yeniden çizildiği için olayları kapta yakalıyoruz (event delegation).
    const mats = ctx.app.querySelector<HTMLElement>("#ai-mats")!;
    mats.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === "ai-mat-file" && t.files?.length) {
        addFiles(t.files);
        t.value = "";
      } else if (t.dataset.matActive) {
        setActive(t.dataset.matActive, t.checked).then(refreshMats);
      }
    });
    mats.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!btn) return;
      if (btn.dataset.matsToggle !== undefined) {
        matsOpen = !matsOpen;
        refreshMats();
      } else if (btn.dataset.matDel) {
        const m = materialsNow()?.find((x) => x.id === btn.dataset.matDel);
        if (m && confirm(`"${m.name}" bu cihazdan silinsin mi?`)) removeMaterial(m.id).then(refreshMats);
      }
    });

    // Fotoğraf: ataş düğmesi, ya da ekran görüntüsünü yapıştırma (Ctrl+V).
    ctx.app.querySelector<HTMLInputElement>("#ai-photo")!.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.files?.[0]) attachImage(t.files[0]);
      t.value = "";
    });
    input.addEventListener("paste", (e) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        attachImage(file);
      }
    });
    ctx.app.querySelector("#ai-chip-wrap")!.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-chip-del]")) {
        pendingImage = undefined;
        refreshChip();
      }
    });
  }

  // Öneri kartının düğmeleri. Mesajlar yeniden çizildiği için olayı listede yakalıyoruz.
  list.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!btn) return;
    if (btn.dataset.openTt !== undefined) return ctx.openTimetable();
    const idx = Number(btn.dataset.add ?? btn.dataset.cancel);
    const p = hist()[idx]?.proposal;
    if (!p || p.status !== "pending") return;
    if (btn.dataset.add !== undefined) {
      p.blocks.forEach((b) => putBlock({ ...b, updatedAt: Date.now() }));
      p.status = "added";
      ctx.changed();
      toast(`${p.blocks.length} blok programa eklendi. Gazzla!`);
    } else {
      p.status = "cancelled";
    }
    ctx.rerender();
  });
}

/** Son cevabın balonunu yeniden çizer (o modun sayfası hâlâ açıksa). Her parça gelişinde çağrılır. */
function updateLast(h: Msg[]): void {
  const list = document.querySelector<HTMLElement>("#ai-messages");
  if (!list || h !== hist()) return; // başka sayfa ya da öbür mod açık; geçmiş yine güncelleniyor
  const i = h.length - 1;
  const el = list.querySelector<HTMLElement>(`.ai-msg[data-i="${i}"]`);
  if (!el) return;
  el.outerHTML = bubbleHtml(h[i], i);
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

// ---------- Gönderme ----------

const ERRORS: Record<string, string> = {
  "no-key": "Asistan henüz kurulmamış: .env.local dosyasına anahtar eklenip npm run dev yeniden başlatılmalı.",
  "no-study-key":
    "Ders asistanı henüz kurulmamış: .env.local dosyasındaki GEMINI_API_KEY satırına anahtar eklenip npm run dev yeniden başlatılmalı.",
  "rate-limit": "Biraz fazla hızlı gittik. Bir dakika sonra tekrar dene.",
  "study-rate-limit": "Ders asistanının kullanım sınırı doldu. Biraz bekle; günlük sınır dolduysa yarın yenilenir.",
  "too-big": "Dosya çok büyük.",
  upload: "Materyal hazırlanamadı. Biraz sonra tekrar dene.",
};

/** Hata cevabındaki kodu okuyup kullanıcıya gösterilecek cümleyi döndürür. */
async function errorText(res: Response, study: boolean): Promise<string> {
  const code = await res.json().then((j) => j.error as string).catch(() => "");
  const key = study && code === "rate-limit" ? "study-rate-limit" : code;
  return ERRORS[key] ?? "Gazzla AI'ya şu an ulaşılamıyor. Biraz sonra tekrar dene.";
}

/** Koç: Groq aracısına sohbet + araç tanımı. */
function coachRequest(ctx: AssistantCtx, h: Msg[], answer: Msg): Promise<Response> {
  const messages = [
    { role: "system", content: systemPrompt(ctx) },
    ...h
      .filter((m) => m !== answer && !m.error)
      .slice(-20)
      .map((m) => ({
        role: m.role,
        content: m.proposal ? `${m.content}\n${proposalSummary(m.proposal)}`.trim() : m.content,
      })),
  ];
  return fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, tools: TOOLS }),
  });
}

function studySystemPrompt(ctx: AssistantCtx, names: string[]): string {
  return [
    "Sen Gazzla Ders Asistanısın: Gazzla adlı çalışma uygulamasının ders çalışma asistanı. Kullanıcı üniversite öğrencisi (ETH Zürih).",
    "Görevin: anlamadığı yeri açık ve sade anlatmak, sınav ve alıştırma sorularını adım adım çözmek, özet çıkarmak,",
    "istenirse ona soru sorup cevabını değerlendirmek. Öğretmen gibi ol: önce sezgi, sonra ayrıntı; gerekirse küçük bir örnek.",
    names.length
      ? `Kullanıcının yüklediği materyaller son mesaja ekli, sırasıyla: ${names.map((n, i) => `${i + 1}) ${n}`).join(", ")}.`
      : "Şu an ekli materyal yok; genel bilginle cevap ver, gerekirse materyal eklemesini öner.",
    "Materyale dayanıyorsan kaynağı kısaca belirt (dosya adı, sayfa ya da soru numarası). Materyalde yoksa bunu söyle, sonra genel bilginle cevapla.",
    "Kullanıcıyla Türkçe konuş. Materyal Almanca ya da İngilizce olabilir; önemli terimlerin orijinalini parantezde ver.",
    "Formülleri LaTeX kullanmadan, düz yazı ve Unicode ile yaz (x², xₙ, √, ∫, ∑, ∂, ≤, ≠, →, ∞, α, λ). Tablo kullanma.",
    "Kısa başlıklar, maddeler ve **kalın** kullanabilirsin. Gereksiz uzatma.",
    "Hangi şirketin ya da hangi dil modelinin olduğunu asla söyleme; sorulursa \"Ben Gazzla Ders Asistanıyım\" de.",
    "Marka adı her zaman \"Gazzla\" (iki z).",
    "",
    "Kullanıcının çalışma verileri (gerekirse kullan):",
    ctx.contextText(),
  ].join("\n");
}

/** Ders asistanı: işaretli materyalleri (gerekirse) yükleyip Gemini aracısına sohbet gönderir. */
async function studyRequest(ctx: AssistantCtx, h: Msg[], answer: Msg): Promise<Response> {
  const mats = (await loadMaterials()).filter((m) => m.active);
  const post = async (force: boolean) => {
    if (mats.length) {
      answer.note = "materyaller okunuyor...";
      updateLast(h);
    }
    const ready = await Promise.all(mats.map((m) => ensureUploaded(m, force)));
    refreshMats();
    const files = ready.map((m) => m.remote!).map(({ uri, mimeType }) => ({ uri, mimeType }));
    const past = h.filter((m) => m !== answer && !m.error).slice(-12);
    const messages = past.map((m, i) => {
      const last = i === past.length - 1;
      return {
        role: m.role,
        text: m.image && !last ? `${m.content}\n[Burada bir görsel vardı]` : m.content,
        image: last ? m.image : undefined, // eski görselleri tekrar göndermiyoruz (istek hafif kalsın)
        files: last ? files : undefined,
      };
    });
    return fetch("/api/study", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: studySystemPrompt(ctx, mats.map((m) => m.name)), messages }),
    });
  };
  let res = await post(false);
  // Serviste dosyanın süresi dolmuşsa bir kez yeniden yükleyip dene.
  if (res.status === 410 && mats.length) res = await post(true);
  return res;
}

async function send(ctx: AssistantCtx, text: string): Promise<void> {
  const content = text.trim();
  const image = mode === "study" ? pendingImage : undefined;
  if ((!content && !image) || busy) return;
  busy = true;
  stopSpeaking();
  const m = mode;
  const h = histories[m];
  h.push({ role: "user", content: content || "Bu görseldeki soruyu çöz.", image });
  pendingImage = undefined;
  const answer: Msg = { role: "assistant", content: "" };
  h.push(answer);
  if (document.querySelector("#ai-messages")) ctx.rerender();

  let ok = false;
  try {
    const res = m === "coach" ? await coachRequest(ctx, h, answer) : await studyRequest(ctx, h, answer);
    answer.note = undefined;
    if (!res.ok || !res.body) throw new Error(await errorText(res, m === "study"));
    // Cevap satır satır JSON olarak geliyor: {"text": "..."} ya da {"tool": "...", "args": "..."}.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as { text?: string; tool?: string; args?: string };
        if (msg.text) answer.content += msg.text;
        if (msg.tool === "program_oner") answer.proposal = toProposal(msg.args ?? "");
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
      updateLast(h);
    }
    handle(buffer);
    if (answer.proposal && !answer.content.trim())
      answer.content = answer.proposal.blocks.length ? "Şunları programına ekleyeyim mi?" : "";
    if (!answer.content && !answer.proposal) throw new Error("Boş cevap geldi. Tekrar dener misin?");
    ok = true;
  } catch (err) {
    answer.error = true;
    answer.note = undefined;
    answer.proposal = undefined;
    const msg = err instanceof Error ? err.message : "";
    answer.content = ERRORS[msg] ?? (msg || "Bir şeyler ters gitti.");
  } finally {
    busy = false;
    if (document.querySelector("#ai-messages")) ctx.rerender();
  }
  if (ok && voiceMode && m === mode) speak(answer.content, ctx);
}

// ---------- Ses: kayıt (konuşma → yazı) ----------

const VOICE_KEY = "gazzla.aiVoice";
let voiceMode = (() => {
  try {
    return localStorage.getItem(VOICE_KEY) === "1";
  } catch {
    return false;
  }
})();

let recState: "idle" | "rec" | "transcribing" = "idle";
let recorder: MediaRecorder | undefined;
let discardRec = false;

/** Mikrofon düğmesinin görünümü (sayfayı baştan çizmeden; yazılmış metin kaybolmasın). */
function updateMicUi(): void {
  const mic = document.querySelector<HTMLButtonElement>("#ai-mic");
  const input = document.querySelector<HTMLTextAreaElement>("#ai-input");
  if (!mic || !input) return;
  mic.classList.toggle("rec", recState === "rec");
  mic.classList.toggle("wait", recState === "transcribing");
  mic.disabled = busy || recState === "transcribing";
  mic.innerHTML = recState === "rec" ? STOP_ICON : MIC_ICON;
  mic.setAttribute("aria-label", recState === "rec" ? "Kaydı bitir" : "Sesle yaz");
  input.placeholder =
    recState === "rec" ? "Dinliyorum... (susunca gönderirim)" : recState === "transcribing" ? "Yazıya çeviriyorum..." : "Gazzla AI'ya yaz...";
}

async function startRec(ctx: AssistantCtx): Promise<void> {
  if (busy || recState !== "idle") return;
  stopSpeaking();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("Bu tarayıcı ses kaydını desteklemiyor.");
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Mikrofon izni verilmedi.");
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  // Sessizlik algılama: ses şiddetini 100 ms'de bir ölçüyoruz (RMS). Konuştuktan sonra 1,5 sn
  // sessizlik olunca kayıt kendiliğinden biter. Hiç konuşulmazsa 8 sn sonra vazgeçer; en fazla 60 sn.
  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const startedAt = Date.now();
  let lastLoud = 0;
  let heard = false;
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    if (rms > 0.02) {
      heard = true;
      lastLoud = now;
    }
    if (heard && now - lastLoud > 1500) stopRec(false);
    else if (!heard && now - startedAt > 8000) stopRec(true);
    else if (now - startedAt > 60000) stopRec(false);
  }, 100);

  rec.onstop = async () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    audioCtx.close().catch(() => {});
    recorder = undefined;
    if (discardRec || !heard || chunks.length === 0) {
      recState = "idle";
      updateMicUi();
      if (!heard && !discardRec) toast("Bir şey duyamadım.");
      return;
    }
    recState = "transcribing";
    updateMicUi();
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    let text = "";
    try {
      const res = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      const json = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(ERRORS[json.error ?? ""] ?? "Ses yazıya çevrilemedi.");
      text = json.text ?? "";
    } catch (err) {
      toast(err instanceof Error ? err.message : "Ses yazıya çevrilemedi.");
    }
    recState = "idle";
    updateMicUi();
    // Gürültüde model bazen sadece "." gibi şeyler döndürüyor; içinde harf yoksa gönderme.
    if (/\p{L}/u.test(text)) send(ctx, text);
    else toast("Bir şey anlayamadım, tekrar dener misin?");
  };

  discardRec = false;
  recorder = rec;
  recState = "rec";
  rec.start();
  updateMicUi();
}

/** Kaydı bitirir. discard = true ise kayıt atılır (hiç konuşulmadı). */
function stopRec(discard: boolean): void {
  if (!recorder || recorder.state === "inactive") return;
  discardRec = discard;
  recorder.stop();
}

// ---------- Ses: okuma (yazı → konuşma) ----------
// Tarayıcının kendi sesleri (Edge'de "Microsoft ... Online (Natural)" Türkçe sesler çok iyi).

function turkishVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("tr"));
  return voices.find((v) => /natural|online/i.test(v.name)) ?? voices[0];
}

function stopSpeaking(): void {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function speak(text: string, ctx: AssistantCtx): void {
  if (!("speechSynthesis" in window)) return;
  const clean = text.replace(/[*#_`|>]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "tr-TR";
  const v = turkishVoice();
  if (v) u.voice = v;
  u.rate = 1.05;
  // Okuma bitince, sesli sohbet hâlâ açıksa ve sayfadaysak yeniden dinlemeye başla.
  u.onend = () => {
    if (voiceMode && document.querySelector("#ai-messages") && !busy) startRec(ctx);
  };
  speechSynthesis.speak(u);
}
// Bazı tarayıcılar ses listesini geç yüklüyor; önceden isteyelim.
if ("speechSynthesis" in window) speechSynthesis.getVoices();
