// "Gazzla AI" sayfası: kullanıcının çalışma verilerini bilen sohbet asistanı.
// İstekler aiApi.ts üzerinden sunucuya (supabase/functions/gazzla-ai) gider; anahtarlar orada.
// Canlıda giriş şart ve herkesin günlük hakkı var. Sohbetler yalnız bu cihazda saklanır (görselsiz).
//
// İki mod var: "Koç" (Groq) ve "Ders asistanı" (ülkeye göre Gemini ya da Groq; materyaller study.ts'te,
// Groq yolunda yazı çıkarma extract.ts'te).
// Koç modu üç iş yapıyor:
//   1. Sohbet (cevap parça parça gelir).
//   2. Programa blok önerme: model "program_oner" aracını çağırır, biz bir önizleme kartı gösteririz;
//      kullanıcı "Programa ekle" demeden hiçbir şey eklenmez.
//   3. Sesli sohbet: mikrofon kaydı yazıya çevrilir (sessizlik olunca kendiliğinden durur),
//      cevap tarayıcının Türkçe sesiyle okunur, sonra tekrar dinlemeye başlar.
//
// main.ts'teki ortak şeyleri bir "ctx" nesnesiyle alıyoruz (timetableView.ts'teki gibi).

import { toast } from "./effects";
import { aiFetch, loadStatus, spent, statusNow } from "./aiApi";
import { extractPages, pickContext } from "./extract";
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
  setFolderActive,
  sizeText,
  type Material,
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
  openTimer: () => void; // Zamanlayıcıya geç
  /** Zamanlayıcıyı ayarlar (start = true ise başlatır). Seans sürüyorsa ok = false. */
  setupSession: (minutes: number, project: string | undefined, start: boolean) => { ok: boolean; text: string };
  /** Kullanıcının o anki verileri (süreler, hedefler, projeler, bugünkü program) düz metin olarak. */
  contextText: () => string;
  signedIn: () => boolean; // canlıda Gazzla AI için giriş şart
  openAccount: () => void; // Hesap (giriş) sayfasına geç
}

interface Proposal {
  blocks: Block[];
  skipped: number; // anlaşılamayan (saati bozuk vb.) öneri sayısı
  status: "pending" | "added" | "cancelled";
}

interface SessionCard {
  minutes: number;
  project?: string;
  ok: boolean;
  started: boolean;
  text: string;
}

type Msg = {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  proposal?: Proposal; // programa ekleme önerisi
  session?: SessionCard; // zamanlayıcı ayarlandı/başlatıldı
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
// ---------- Sohbet geçmişi ----------
// Her modun son 20 sohbeti bu cihazda (localStorage) durur; görseller ve hata mesajları kaydedilmez.
// C++ benzetmesi: her mod için bir std::vector<Chat>, en yenisi başta.

interface Chat {
  id: string;
  title: string;
  updatedAt: number;
  msgs: Msg[];
}
const CHATS_KEY = "gazzla.aiChats";
const MAX_CHATS = 20;

function newChat(): Chat {
  return { id: crypto.randomUUID(), title: "", updatedAt: Date.now(), msgs: [] };
}

function loadChats(): Record<Mode, Chat[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(CHATS_KEY) ?? "{}");
    return { coach: Array.isArray(raw.coach) ? raw.coach : [], study: Array.isArray(raw.study) ? raw.study : [] };
  } catch {
    return { coach: [], study: [] };
  }
}

const chats: Record<Mode, Chat[]> = loadChats();
const current: Record<Mode, Chat> = { coach: newChat(), study: newChat() };
const hist = () => current[mode].msgs;
let historyOpen = false;

/** Şu anki sohbeti geçmişe yazar (görselsiz, hatasız). */
function saveChat(m: Mode): void {
  const c = current[m];
  const msgs: Msg[] = c.msgs
    .filter((x) => !x.error && (x.content || x.proposal || x.session))
    .map(({ image, note: _note, ...rest }) => (image ? { ...rest, content: `${rest.content}\n[görsel]` } : rest));
  if (!msgs.length) return;
  const first = msgs.find((x) => x.role === "user");
  const entry: Chat = { id: c.id, title: (first?.content ?? "Sohbet").replace(/\s+/g, " ").slice(0, 60), updatedAt: Date.now(), msgs };
  chats[m] = [entry, ...chats[m].filter((x) => x.id !== c.id)].slice(0, MAX_CHATS);
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch {
    // Depo doluysa eski sohbetleri at ve yeniden dene.
    chats[m] = chats[m].slice(0, 5);
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
    } catch {
      /* kaydedilemedi; sohbet yine de ekranda */
    }
  }
}

function deleteChat(m: Mode, id: string): void {
  chats[m] = chats[m].filter((x) => x.id !== id);
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch {
    /* sorun değil */
  }
}

/** Bu kadar mesajdan sonra "yeni sohbete geç" önerisi çıkar (her soruda bütün sohbet yeniden gönderiliyor). */
const NUDGE_AT: Record<Mode, number> = { coach: 8, study: 6 };
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

/**
 * Araç kuralları: iki modda da aynı (Koç ve Ders asistanı sitede aynı işleri yapabilsin).
 * Program önerme + zamanlayıcıyı ayarlama/başlatma.
 */
function toolRules(): string {
  return [
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
    "",
    "SEANS: Kullanıcı çalışma seansı/zamanlayıcı ayarlamanı ya da başlatmanı isterse (ör. \"50 dk Analysis çalışacağım\",",
    "\"25 dakikalık seans başlat\") seans_ayarla aracını çağır. minutes = dakika; saat söylenirse dakikaya çevir.",
    "  project: listedeki proje adı (aynen); listede yoksa ya da belirtilmediyse boş bırak (genel çalışma).",
    "  start=true SADECE kullanıcı şimdi başlatmak istiyorsa (\"başlat\", \"hadi başlayalım\"); yoksa false (sadece hazırla).",
    "  Süre söylenmediyse ve kullanıcı bir öneri istiyorsa makul bir süre seç (ör. 50 dk).",
    "  Aracı çağırdıktan sonra tek kısa, gaz veren cümle yaz.",
    `Projeler: ${loadSubjects().join(", ") || "(henüz yok)"}.`,
    `Tarihler: ${upcomingDays()}.`,
  ].join("\n");
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
    toolRules(),
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
  {
    type: "function",
    function: {
      name: "seans_ayarla",
      description:
        "Zamanlayıcıda çalışma seansını ayarlar: süreyi ve projeyi seçer; start=true ise hemen başlatır.",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "integer", minimum: 1, maximum: 600, description: "Seansın süresi, dakika" },
          project: { type: "string", description: "Proje adı, listeden aynen; yoksa boş (genel çalışma)" },
          start: { type: "boolean", description: "Kullanıcı şimdi başlatmak istiyorsa true, sadece hazırlamak için false" },
        },
        required: ["minutes", "start"],
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
/** Mesaj metni + (varsa) araç sonuçlarının kısa notu; modele geçmişi hatırlatmak için. */
function withToolNotes(m: Msg): string {
  const notes = [m.proposal ? proposalSummary(m.proposal) : "", m.session ? `[Zamanlayıcı: ${m.session.text}]` : ""];
  return [m.content, ...notes].filter(Boolean).join("\n").trim();
}

/** seans_ayarla çağrısını çalıştırır (main.ts'teki setupSession). */
function runSession(ctx: AssistantCtx, argsJson: string, userText: string): SessionCard {
  let a: { minutes?: unknown; project?: unknown; start?: unknown } = {};
  try {
    a = JSON.parse(argsJson || "{}");
  } catch {
    /* bozuksa varsayılanlar */
  }
  const minutes = Math.min(600, Math.max(1, Math.round(Number(a.minutes) || 50)));
  const project = typeof a.project === "string" && a.project.trim() ? a.project.trim() : undefined;
  // Model bazen "hazırla" deyince de başlatıyor. Güvenlik kemeri: kullanıcının mesajında açık bir başlatma
  // isteği yoksa sadece hazırla (kartta "Başlat" düğmesi çıkar). "başlayacağım" gibi gelecek zaman sayılmaz.
  const asked = /başlat|başlayalım|başlıyorum|başla(?=[\s!.,]|$)|hemen|şimdi|hadi|\bstart\b|\bgo\b/i.test(userText);
  const start = a.start === true && asked;
  const r = ctx.setupSession(minutes, project, start);
  return { minutes, project, ok: r.ok, started: r.ok && start, text: r.text };
}

function sessionHtml(sc: SessionCard, i: number): string {
  const actions = !sc.ok
    ? ""
    : sc.started
      ? `<button class="small ghost" data-open-timer>Zamanlayıcıya git →</button>`
      : `<button class="small primary" data-sess-start="${i}">Başlat</button>
         <button class="small ghost" data-open-timer>Zamanlayıcıya git →</button>`;
  return `
    <div class="ai-plan ${sc.ok ? "" : "cancelled"}">
      <div class="ai-plan-title">Zamanlayıcı</div>
      <p class="ai-session-line">${escapeHtml(sc.text)}</p>
      ${actions ? `<div class="ai-plan-actions">${actions}</div>` : ""}
    </div>`;
}

function proposalSummary(p: Proposal): string {
  const list = p.blocks.map((b) => `${whenText(b)} ${clockText(b.start)}–${clockText(b.end)} ${blockName(b)}`).join("; ");
  const state = p.status === "added" ? "kullanıcı programa ekledi" : p.status === "cancelled" ? "kullanıcı vazgeçti" : "kullanıcı henüz onaylamadı";
  return `[Programa ekleme önerin: ${list || "geçerli blok yok"}. Durum: ${state}]`;
}

// ---------- Çizim ----------

// ---------- LaTeX → okunur yazı ----------
// Modeller "LaTeX kullanma" talimatına her zaman uymuyor (\(x^{3}\), \frac{a}{b}...). Ayrı bir kütüphane
// (KaTeX) eklemek yerine en sık kalıpları Unicode'a çeviriyoruz: x^{3} → x³, x_{n} → xₙ, \frac{a}{b} → (a)/(b).

const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", x: "ˣ", k: "ᵏ", T: "ᵀ", "*": "*", "'": "′",
};
const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", i: "ᵢ", j: "ⱼ", n: "ₙ", m: "ₘ", k: "ₖ",
};
const SYM: Record<string, string> = {
  cdot: "·", times: "×", div: "÷", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈",
  infty: "∞", to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", implies: "⇒", Leftrightarrow: "⇔",
  iff: "⇔", mapsto: "↦", in: "∈", notin: "∉", subseteq: "⊆", subset: "⊂", cup: "∪", cap: "∩", emptyset: "∅",
  forall: "∀", exists: "∃", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", oint: "∮", pm: "±",
  mp: "∓", alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", Pi: "Π", rho: "ρ", sigma: "σ", Sigma: "Σ", tau: "τ", phi: "φ", varphi: "φ", Phi: "Φ",
  chi: "χ", psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω", Gamma: "Γ", Theta: "Θ", ldots: "…", dots: "…",
  cdots: "⋯", circ: "∘", langle: "⟨", rangle: "⟩", lvert: "|", rvert: "|", mid: "|", vert: "|", equiv: "≡",
  sim: "∼", propto: "∝", perp: "⊥", parallel: "∥", angle: "∠", deg: "°", neg: "¬", land: "∧", lor: "∨",
  quad: " ", qquad: "  ", lim: "lim", sin: "sin", cos: "cos", tan: "tan", log: "log", ln: "ln", exp: "exp",
  det: "det", max: "max", min: "min", sup: "sup", inf: "inf", ker: "ker", dim: "dim",
};
const BB: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ" };

const script = (map: Record<string, string>, mark: string) => (s: string) =>
  [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : `${mark}(${s})`;
const toSup = script(SUP, "^");
const toSub = script(SUB, "_");

function latexToText(t: string): string {
  if (!/\\[a-zA-Z()[\]]|\$|\^\{|_\{/.test(t)) return t;
  let s = t
    .replace(/\$\$([\s\S]+?)\$\$/g, "$1")
    .replace(/\$([^$\n]*[\\^_=][^$\n]*)\$/g, "$1") // tek $: yalnız içinde formül işareti varsa (5$ gibi fiyatlar kalsın)
    .replace(/\\\[|\\\]|\\\(|\\\)/g, "")
    .replace(/\\begin\{[a-z*]+\}(\{[^}]*\})?|\\end\{[a-z*]+\}/g, "")
    .replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|limits)\b/g, "")
    .replace(/\\mathbb\{([RNZQC])\}/g, (_, c: string) => BB[c])
    // Önce en içtekiler: üs ve alt indis. Sonra (birkaç turda) onları saran kalıplar.
    .replace(/\^\{([^{}]*)\}/g, (_, x: string) => toSup(x))
    .replace(/_\{([^{}]*)\}/g, (_, x: string) => toSub(x));
  for (let i = 0; i < 3; i++)
    s = s
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|textbf|textit|mathcal)\{([^{}]*)\}/g, "$1")
      .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
      .replace(/\\boxed\{([^{}]*)\}/g, "**$1**")
      .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a: string, b: string) => {
        const wrap = (x: string) => (/^[\w.²³⁰-⁹]+$/u.test(x) ? x : `(${x})`);
        return `${wrap(a)}/${wrap(b)}`;
      });
  return s
    .replace(/\^([0-9a-zA-Z+\-'*])/g, (_, x: string) => toSup(x))
    .replace(/_([0-9a-z])(?![a-z])/g, (_, x: string) => toSub(x))
    .replace(/\\([a-zA-Z]+)/g, (m, name: string) => SYM[name] ?? m)
    .replace(/\\[,;:! ]/g, " ")
    .replace(/\\\\/g, "\n")
    .replace(/&(?=\s*[=≤≥<>≈→])/g, "")
    .replace(/^\s*-{3,}\s*$/gm, "")
    .replace(/[ \t]{2,}/g, " ");
}

/**
 * Asistan cevabını güvenli HTML'e çevirir: önce LaTeX'i sadeleştir, sonra kaçış (escape), sonra biraz Markdown:
 * başlıklar kalın satır, "- " maddeler "• ", **kalın**, `kod`, satır sonları.
 */
function formatText(text: string): string {
  const plain = latexToText(text)
    // Markdown tablosu: ayraç satırını at, her satırı "a · b · c" yap (tablo istemiyoruz ama bazen geliyor).
    .replace(/^[ \t]*\|[ \t:|-]+\|[ \t]*$/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row: string) => row.split("|").map((c) => c.trim()).filter(Boolean).join(" · "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return escapeHtml(plain)
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
  const body = text || m.proposal || m.session ? text : typing;
  const img = m.image ? `<img class="ai-msg-img" src="${m.image}" alt="Eklenen görsel" />` : "";
  return `<div class="ai-msg ${m.role} ${m.error ? "error" : ""} ${m.proposal || m.session ? "has-plan" : ""}" data-i="${i}">
      ${img}${body}${m.proposal ? proposalHtml(m.proposal, i) : ""}${m.session ? sessionHtml(m.session, i) : ""}
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

const openFolders = new Set<string>(); // panelde açık klasör grupları
const reading = new Map<string, string>(); // Groq yolu: okunmakta olan materyal → "3/40"
const KIND_OF = (m: Material) => (m.mimeType === "application/pdf" ? "PDF" : m.mimeType.startsWith("image/") ? "IMG" : "TXT");
const studyProvider = () => statusNow()?.study ?? "files";

function stateText(m: Material): string {
  if (studyProvider() === "excerpts") {
    const r = reading.get(m.id);
    if (r) return `okunuyor ${r}`;
    return m.pages?.length ? "hazır" : "";
  }
  if (isUploading(m.id)) return "hazırlanıyor...";
  return m.remote && m.remote.expiresAt > Date.now() ? "hazır" : "";
}

function matRowHtml(m: Material, nested = false): string {
  const state = stateText(m);
  return `
    <li class="ai-mat ${m.active ? "" : "off"} ${nested ? "nested" : ""}">
      <label>
        <input type="checkbox" data-mat-active="${m.id}" ${m.active ? "checked" : ""} />
        <span class="ai-mat-kind">${KIND_OF(m)}</span>
        <span class="ai-mat-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
      </label>
      <span class="muted ai-mat-meta">${sizeText(m.size)}${state ? ` · ${state}` : ""}</span>
      <button type="button" class="icon ai-mat-del" data-mat-del="${m.id}" title="Sil" aria-label="${escapeHtml(m.name)} sil">×</button>
    </li>`;
}

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
      <span class="ai-mats-btns">
        <label class="small ghost ai-mats-add">+ Dosya<input type="file" id="ai-mat-file" accept="${ACCEPT}" multiple hidden /></label>
        <label class="small ghost ai-mats-add">+ Klasör<input type="file" id="ai-mat-folder" webkitdirectory multiple hidden /></label>
      </span>
    </div>`;
  if (!matsOpen) return head;

  // Klasörden gelenleri grupla; tek tek eklenenler ayrı satır.
  const groups = new Map<string, Material[]>();
  const singles: Material[] = [];
  for (const m of mats) {
    if (m.folder) groups.set(m.folder, [...(groups.get(m.folder) ?? []), m]);
    else singles.push(m);
  }
  const folderRows = [...groups.entries()]
    .map(([name, list]) => {
      const on = list.filter((m) => m.active).length;
      const open = openFolders.has(name);
      return `
        <li class="ai-mat ai-folder ${on ? "" : "off"}">
          <label>
            <input type="checkbox" data-folder-active="${escapeHtml(name)}" ${on === list.length ? "checked" : ""} />
            <span class="ai-mat-kind">KLS</span>
            <span class="ai-mat-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          </label>
          <span class="muted ai-mat-meta">${list.length} dosya · ${on} işaretli</span>
          <button type="button" class="icon ai-mat-del" data-folder-open="${escapeHtml(name)}" aria-expanded="${open}"
            title="${open ? "Kapat" : "Dosyaları göster"}">${open ? "▴" : "▾"}</button>
          <button type="button" class="icon ai-mat-del" data-folder-del="${escapeHtml(name)}" title="Klasörü sil" aria-label="${escapeHtml(name)} klasörünü sil">×</button>
        </li>
        ${open ? list.map((m) => matRowHtml(m, true)).join("") : ""}`;
    })
    .join("");
  const rows = folderRows + singles.map((m) => matRowHtml(m)).join("");
  return `
    ${head}
    ${
      mats.length
        ? `<ul class="ai-mat-list">${rows}</ul>
           <p class="muted small-note">İşaretli materyaller her soruda okunur. Sadece o anki derse ait olanları işaretli tut, cevap hızlı gelsin ve hakkın geç dolsun.</p>`
        : `<p class="muted small-note">PDF (ders notu, kitap, eski sınav), metin ya da fotoğraf ekle; bir klasörün tamamını da buraya sürükleyip bırakabilirsin. Drive'daki bir klasör için: Drive'da klasöre sağ tık → İndir, zip'i aç, klasörü buraya bırak. Dosyalar bu cihazda kalır.</p>`
    }`;
}

function refreshMats(): void {
  const el = document.querySelector<HTMLElement>("#ai-mats");
  if (el) el.innerHTML = matsHtml();
}

const SUPPORTED = /\.(pdf|txt|md|csv|png|jpe?g|webp|heic|heif)$/i;

// Groq yolunda dosyaları sırayla oku (aynı anda hepsini okumak dakikalık sınırı doldurur).
let readQueue: Promise<void> = Promise.resolve();
function queueRead(m: Material): void {
  readQueue = readQueue.then(async () => {
    try {
      await extractPages(m, (d, t) => {
        reading.set(m.id, `${d}/${t}`);
        refreshMats();
      });
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      toast(code === "ocr-daily-limit" ? "Bugünkü sayfa okuma hakkın doldu; kalan sayfalar yarın okunur." : `${m.name} okunamadı.`);
    } finally {
      reading.delete(m.id);
      refreshMats();
    }
  });
}

/** Dosyaları materyal olarak ekler. folderOf: dosyanın hangi klasörden geldiği (yoksa tek dosya). */
async function addFiles(files: File[], folderOf: (f: File) => string | undefined = () => undefined): Promise<void> {
  let skipped = 0;
  let added = 0;
  for (const file of files) {
    if (!SUPPORTED.test(file.name) || file.size > MAX_SIZE) {
      skipped++;
      continue;
    }
    const m = await addMaterial(file, folderOf(file));
    added++;
    if (studyProvider() === "excerpts") queueRead(m);
    else
      ensureUploaded(m)
        .catch(() => {
          /* soru sorulunca yeniden denenir */
        })
        .finally(refreshMats);
  }
  refreshMats();
  if (added > 1) toast(`${added} materyal eklendi.`);
  if (skipped) toast(`${skipped} dosya atlandı (desteklenmeyen tür ya da 50 MB'tan büyük).`);
}

/** Sürükle-bırak: klasörleri (alt klasörler dahil) gezip dosyaları toplar. */
async function filesFromDrop(dt: DataTransfer): Promise<{ file: File; folder?: string }[]> {
  const entries = [...dt.items]
    .map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => Boolean(e));
  if (!entries.length) return [...dt.files].map((file) => ({ file }));
  const out: { file: File; folder?: string }[] = [];
  const walk = async (entry: FileSystemEntry, top?: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, folder: top });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, top ?? entry.name);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
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
const HISTORY_ICON = svg('<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/><path d="M12 8v4l3 2"/>');
const PLUS_ICON = svg('<path d="M12 5v14M5 12h14"/>');
const CLIP_ICON = svg('<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7-7L13 4.5a3.4 3.4 0 0 1 4.8 4.8l-7.7 7.7a1.7 1.7 0 0 1-2.4-2.4l7-7"/>');

const NOTICE_KEY = "gazzla.aiNotice";

/** Bugün kalan hak ("Bugün 23 soru hakkın var"). Yerelde (sınırsız) boş. */
function leftText(): string {
  const st = statusNow();
  if (!st || import.meta.env.DEV) return "";
  const n = mode === "coach" ? st.left.coach : st.left.study;
  return n > 0 ? `Bugün ${n} soru hakkın var` : "Bugünkü hakkın doldu";
}

function refreshLeft(): void {
  const el = document.querySelector<HTMLElement>("#ai-left");
  if (el) el.textContent = leftText();
}

function historyHtml(): string {
  const list = chats[mode];
  if (!list.length) return `<div class="ai-history"><p class="muted small-note">Henüz kayıtlı sohbet yok. Sohbetler sadece bu cihazda saklanır.</p></div>`;
  return `
    <div class="ai-history">
      <ul>
        ${list
          .map(
            (c) => `
          <li class="${c.id === current[mode].id ? "on" : ""}">
            <button type="button" class="ai-history-open" data-chat-open="${c.id}">
              <span class="ai-history-title">${escapeHtml(c.title || "Sohbet")}</span>
              <span class="muted">${new Date(c.updatedAt).toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} · ${c.msgs.length} mesaj</span>
            </button>
            <button type="button" class="icon ai-mat-del" data-chat-del="${c.id}" title="Sil" aria-label="Sohbeti sil">×</button>
          </li>`,
          )
          .join("")}
      </ul>
    </div>`;
}

function nudgeHtml(): string {
  if (busy || hist().length < NUDGE_AT[mode]) return "";
  return `
    <div class="ai-nudge">
      <span>Bu sohbet uzadı. Her soruda bütün sohbet yeniden gönderiliyor; yeni bir sohbete geçersen cevaplar hızlanır ve hakkın daha geç dolar.</span>
      <button type="button" class="small primary" data-new-chat>Yeni sohbet</button>
    </div>`;
}

function noticeHtml(): string {
  let seen = false;
  try {
    seen = localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    /* gizli pencere */
  }
  if (seen) return "";
  return `
    <div class="ai-notice" id="ai-notice">
      <span>Ders asistanına eklediğin materyaller, fotoğraflar ve sorular cevap üretilebilmesi için yapay zeka servisine gönderilir.
      Bulunduğun ülkeye göre bu içerik servis sağlayıcının ürünlerini geliştirmek için kullanılabilir; kişisel ya da hassas belge ekleme.
      <a href="/gizlilik.html" target="_blank" rel="noopener">Gizlilik</a></span>
      <button type="button" class="small ghost" id="ai-notice-ok">Anladım</button>
    </div>`;
}

/** Yeni boş sohbet aç (eskisi geçmişte kalır). */
function startNewChat(): void {
  stopSpeaking();
  saveChat(mode);
  current[mode] = newChat();
  pendingImage = undefined;
}

export function renderAssistant(ctx: AssistantCtx): void {
  // Canlıda giriş şart: günlük hak hesaba bağlı.
  if (!import.meta.env.DEV && !ctx.signedIn()) {
    ctx.app.innerHTML = `
      ${ctx.headerHtml()}
      ${ctx.pageHeadHtml("Yapay zeka asistanı", `<span class="grad-text">Gazzla AI</span>`, "Plan, program, ders. Sor, gazlasın.")}
      <section class="card ai-login">
        <p>Gazzla AI'yı kullanmak için giriş yap. Hesap ücretsiz; her hesabın her gün kendi soru hakkı var.</p>
        <button class="primary" id="ai-login">Giriş yap / hesap aç</button>
      </section>`;
    ctx.app.querySelector("#ai-login")!.addEventListener("click", () => ctx.openAccount());
    return;
  }
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
      ${study ? noticeHtml() : ""}
      <div class="ai-top">
        <button id="ai-voice" class="small ghost ai-voice ${voiceMode ? "on" : ""}" aria-pressed="${voiceMode}"
          title="Açıkken cevapları sesli okur ve okuyunca seni yeniden dinler">
          <span class="ico">${SPEAKER_ICON}</span> Sesli: ${voiceMode ? "açık" : "kapalı"}
        </button>
        <span class="muted ai-left" id="ai-left">${leftText()}</span>
        <span class="ai-top-btns">
          <button class="small ghost ai-voice" id="ai-history-btn" aria-expanded="${historyOpen}" title="Geçmiş sohbetler">
            <span class="ico">${HISTORY_ICON}</span> Geçmiş${chats[mode].length ? ` (${chats[mode].length})` : ""}
          </button>
          <button class="small ghost ai-voice" id="ai-new" ${busy || !hist().length ? "disabled" : ""} title="Yeni sohbet">
            <span class="ico">${PLUS_ICON}</span> Yeni
          </button>
        </span>
      </div>
      ${historyOpen ? historyHtml() : ""}
      <div id="ai-messages" class="ai-messages">${messagesHtml()}</div>
      ${nudgeHtml()}
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
  ctx.app.querySelector("#ai-new")?.addEventListener("click", () => {
    if (busy) return;
    startNewChat();
    historyOpen = false;
    ctx.rerender();
  });
  ctx.app.querySelector("[data-new-chat]")?.addEventListener("click", () => {
    if (busy) return;
    startNewChat();
    ctx.rerender();
  });
  ctx.app.querySelector("#ai-history-btn")?.addEventListener("click", () => {
    historyOpen = !historyOpen;
    ctx.rerender();
  });
  ctx.app.querySelector(".ai-history")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!btn || busy) return;
    if (btn.dataset.chatOpen) {
      const c = chats[mode].find((x) => x.id === btn.dataset.chatOpen);
      if (!c) return;
      stopSpeaking();
      saveChat(mode);
      current[mode] = { ...c, msgs: c.msgs.map((x) => ({ ...x })) };
      historyOpen = false;
      ctx.rerender();
    } else if (btn.dataset.chatDel) {
      deleteChat(mode, btn.dataset.chatDel);
      if (current[mode].id === btn.dataset.chatDel) current[mode] = newChat();
      ctx.rerender();
    }
  });
  ctx.app.querySelector("#ai-notice-ok")?.addEventListener("click", () => {
    try {
      localStorage.setItem(NOTICE_KEY, "1");
    } catch {
      /* sorun değil */
    }
    ctx.app.querySelector("#ai-notice")?.remove();
  });
  // Kalan hakkı ve ders asistanının yolunu (ülkeye göre) sunucudan öğren.
  loadStatus().then(() => {
    refreshLeft();
    if (study) refreshMats();
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
        addFiles([...t.files]);
        t.value = "";
      } else if (t.id === "ai-mat-folder" && t.files?.length) {
        // Klasör seçici: her dosyanın yolu "Klasör/alt/dosya.pdf" gibi; ilk parça klasörün adı.
        addFiles([...t.files], (f) => f.webkitRelativePath.split("/")[0] || undefined);
        t.value = "";
      } else if (t.dataset.matActive) {
        setActive(t.dataset.matActive, t.checked).then(refreshMats);
      } else if (t.dataset.folderActive) {
        setFolderActive(t.dataset.folderActive, t.checked).then(refreshMats);
      }
    });
    // Klasörü ya da dosyaları panele sürükleyip bırakma.
    mats.addEventListener("dragover", (e) => {
      e.preventDefault();
      mats.classList.add("drag");
    });
    mats.addEventListener("dragleave", () => mats.classList.remove("drag"));
    mats.addEventListener("drop", async (e) => {
      e.preventDefault();
      mats.classList.remove("drag");
      if (!e.dataTransfer) return;
      const found = await filesFromDrop(e.dataTransfer);
      const folderOf = new Map(found.map((x) => [x.file, x.folder]));
      addFiles(
        found.map((x) => x.file),
        (f) => folderOf.get(f),
      );
    });
    mats.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!btn) return;
      if (btn.dataset.matsToggle !== undefined) {
        matsOpen = !matsOpen;
        refreshMats();
      } else if (btn.dataset.folderOpen) {
        const f = btn.dataset.folderOpen;
        if (openFolders.has(f)) openFolders.delete(f);
        else openFolders.add(f);
        refreshMats();
      } else if (btn.dataset.folderDel) {
        const f = btn.dataset.folderDel;
        const list = (materialsNow() ?? []).filter((x) => x.folder === f);
        if (list.length && confirm(`"${f}" klasörü (${list.length} dosya) bu cihazdan silinsin mi?`))
          Promise.all(list.map((x) => removeMaterial(x.id))).then(refreshMats);
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
    if (btn.dataset.openTimer !== undefined) return ctx.openTimer();
    if (btn.dataset.sessStart !== undefined) {
      const sc = hist()[Number(btn.dataset.sessStart)]?.session;
      if (!sc || sc.started) return;
      const r = ctx.setupSession(sc.minutes, sc.project, true);
      sc.ok = r.ok;
      sc.started = r.ok;
      sc.text = r.text;
      if (!r.ok) ctx.rerender(); // başarılıysa zaten zamanlayıcıya geçti
      return;
    }
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
  "not-configured": "Gazzla AI henüz kurulmamış (sunucuda anahtar yok).",
  "not-signed-in": "Gazzla AI için giriş yapman gerekiyor.",
  "daily-limit": "Bugünkü soru hakkın doldu. Hakların her gece yenilenir; yarın görüşürüz!",
  "wrong-region": "Bu işlem bulunduğun ülkede kullanılamıyor.",
  "rate-limit": "Biraz fazla hızlı gittik. Bir dakika sonra tekrar dene.",
  "study-rate-limit": "Ders asistanının kullanım sınırı doldu. Biraz bekle; günlük sınır dolduysa yarın yenilenir.",
  "too-big": "Dosya çok büyük.",
  upload: "Materyal hazırlanamadı. Biraz sonra tekrar dene.",
};

/** Hata cevabındaki kodu okuyup kullanıcıya gösterilecek cümleyi döndürür. */
async function errorText(res: Response, study: boolean): Promise<string> {
  const code = await res.json().then((j) => j.error as string).catch(() => "");
  if (code === "daily-limit") loadStatus(true).then(refreshLeft);
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
        content: withToolNotes(m),
      })),
  ];
  return aiFetch("coach", JSON.stringify({ messages, tools: TOOLS }));
}

function studySystemPrompt(names: string[], viaExcerpts = false): string {
  return [
    "Sen Gazzla Ders Asistanısın: Gazzla adlı çalışma uygulamasının ders çalışma asistanı. Kullanıcı üniversite öğrencisi (ETH Zürih).",
    "Görevin: anlamadığı yeri açık ve sade anlatmak, sınav ve alıştırma sorularını adım adım çözmek, özet çıkarmak,",
    "istenirse ona soru sorup cevabını değerlendirmek. Öğretmen gibi ol: önce sezgi, sonra ayrıntı; gerekirse küçük bir örnek.",
    names.length
      ? viaExcerpts
        ? `Kullanıcının materyalleri: ${names.join(", ")}. Bu mesajın sonunda bu materyallerden soruyla ilgili alıntılar var ([dosya, s. N] etiketleriyle); alıntılarda yoksa bunu söyle.`
        : `Kullanıcının yüklediği materyaller son mesaja ekli, sırasıyla: ${names.map((n, i) => `${i + 1}) ${n}`).join(", ")}.`
      : "Şu an ekli materyal yok; genel bilginle cevap ver, gerekirse materyal eklemesini öner.",
    "Materyale dayanıyorsan kaynağı kısaca belirt (dosya adı, sayfa ya da soru numarası). Materyalde yoksa bunu söyle, sonra genel bilginle cevapla.",
    "Kullanıcıyla Türkçe konuş. Materyal Almanca ya da İngilizce olabilir; önemli terimlerin orijinalini parantezde ver.",
    "Formülleri LaTeX kullanmadan, düz yazı ve Unicode ile yaz (x², xₙ, √, ∫, ∑, ∂, ≤, ≠, →, ∞, α, λ). Tablo kullanma.",
    "Kısa başlıklar, maddeler ve **kalın** kullanabilirsin. Gereksiz uzatma.",
    "Hangi şirketin ya da hangi dil modelinin olduğunu asla söyleme; sorulursa \"Ben Gazzla Ders Asistanıyım\" de.",
    "Marka adı her zaman \"Gazzla\" (iki z).",
    "",
    "Sitede işlem de yapabilirsin (araçlarla):",
    toolRules(),
    "",
    // Çalışma verisi ve program bilerek GÖNDERİLMİYOR: program Google Takvim'den gelen etkinlikleri içerebilir ve
    // bu servisin ücretsiz katmanı içerikleri ürün geliştirmede kullanabiliyor (gizlilik sayfasındaki söz).
    `Bugün: ${new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`,
  ].join("\n");
}

/**
 * Ders asistanı. Sunucu ülkeye göre yolu seçer:
 *   - Gemini: işaretli materyaller (gerekirse) yüklenir, soruya dosya olarak eklenir.
 *   - Groq: materyallerin yazısı tarayıcıda çıkarılır, soruyla ilgili alıntılar gönderilir.
 */
async function studyRequest(ctx: AssistantCtx, h: Msg[], answer: Msg): Promise<Response> {
  const mats = (await loadMaterials()).filter((m) => m.active);
  const st = await loadStatus();
  if (st?.study === "excerpts") return studyRequestGroq(h, answer, mats);
  void ctx;
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
        text: m.image && !last ? `${withToolNotes(m)}\n[Burada bir görsel vardı]` : withToolNotes(m),
        image: last ? m.image : undefined, // eski görselleri tekrar göndermiyoruz (istek hafif kalsın)
        files: last ? files : undefined,
      };
    });
    return aiFetch("study", JSON.stringify({ system: studySystemPrompt(mats.map((m) => m.name)), messages, tools: TOOLS }));
  };
  let res = await post(false);
  // Serviste dosyanın süresi dolmuşsa bir kez yeniden yükleyip dene.
  if (res.status === 410 && mats.length) res = await post(true);
  return res;
}

async function studyRequestGroq(h: Msg[], answer: Msg, mats: Material[]): Promise<Response> {
  const extracted: { name: string; pages: string[] }[] = [];
  for (const [i, m] of mats.entries()) {
    answer.note = `materyaller okunuyor (${i + 1}/${mats.length})...`;
    updateLast(h);
    try {
      const pages = await extractPages(m, (d, t) => {
        answer.note = `"${m.name}" okunuyor ${d}/${t}...`;
        reading.set(m.id, `${d}/${t}`);
        updateLast(h);
        refreshMats();
      });
      extracted.push({ name: m.name, pages });
    } catch {
      toast(`${m.name} okunamadı; o olmadan cevaplıyorum.`);
    } finally {
      reading.delete(m.id);
      refreshMats();
    }
  }
  answer.note = mats.length ? "cevap hazırlanıyor..." : undefined;
  updateLast(h);
  const question = [...h].reverse().find((x) => x.role === "user")?.content ?? "";
  const context = pickContext(extracted, question, 7000); // dakikalık sınır küçük: ~2.000 kelimelik alıntı
  const past = h.filter((m) => m !== answer && !m.error).slice(-8);
  const messages = past.map((m, i) => {
    const last = i === past.length - 1;
    return {
      role: m.role,
      text: m.image && !last ? `${withToolNotes(m)}\n[Burada bir görsel vardı]` : withToolNotes(m),
      image: last ? m.image : undefined,
    };
  });
  return aiFetch(
    "study",
    JSON.stringify({ system: studySystemPrompt(extracted.map((x) => x.name), true), context, messages, tools: TOOLS }),
  );
}

async function send(ctx: AssistantCtx, text: string): Promise<void> {
  const content = text.trim();
  const image = mode === "study" ? pendingImage : undefined;
  if ((!content && !image) || busy) return;
  busy = true;
  stopSpeaking();
  const m = mode;
  const h = current[m].msgs;
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
    let sessionArgs: string | undefined; // seans_ayarla akış bitince çalıştırılır (ekran değişebilir)
    const handle = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as { text?: string; tool?: string; args?: string };
        if (msg.text) answer.content += msg.text;
        if (msg.tool === "program_oner") answer.proposal = toProposal(msg.args ?? "");
        if (msg.tool === "seans_ayarla") sessionArgs = msg.args ?? "{}";
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
    if (sessionArgs !== undefined) {
      answer.session = runSession(ctx, sessionArgs, content);
      if (!answer.content.trim()) answer.content = answer.session.ok ? "Tamam, ayarladım. Gazzla!" : "";
    }
    if (answer.proposal && !answer.content.trim())
      answer.content = answer.proposal.blocks.length ? "Şunları programına ekleyeyim mi?" : "";
    if (!answer.content && !answer.proposal && !answer.session) throw new Error("Boş cevap geldi. Tekrar dener misin?");
    ok = true;
    spent(m);
    saveChat(m);
  } catch (err) {
    answer.error = true;
    answer.note = undefined;
    answer.proposal = undefined;
    // TypeError = ağ hatası (internet yok, sunucuya ulaşılamadı); teknik mesajı gösterme.
    const msg = err instanceof TypeError ? "" : err instanceof Error ? err.message : "";
    answer.content = ERRORS[msg] ?? (msg || "Gazzla AI'ya şu an ulaşılamıyor. İnternet bağlantını kontrol edip biraz sonra tekrar dene.");
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
      const res = await aiFetch("transcribe", blob, blob.type);
      const json = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(ERRORS[json.error ?? ""] ?? "Ses yazıya çevrilemedi.");
      text = json.text ?? "";
    } catch (err) {
      toast(err instanceof Error && !(err instanceof TypeError) ? err.message : "Ses yazıya çevrilemedi.");
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
