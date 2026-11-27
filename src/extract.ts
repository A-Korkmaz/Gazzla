// Ders asistanının "Groq yolu" için materyal okuma ve alıntı seçme.
// (İsviçre/AEA/İngiltere'deki kullanıcılar: orada Gemini'nin ücretsiz sürümü kullanılamıyor, Groq ise PDF'i
//  kendisi okuyamıyor. O yüzden yazıyı tarayıcıda biz çıkarıyoruz.)
//
//   1. extractPages: PDF'in her sayfasının yazısını çıkarır. Yazısı olmayan (taranmış) sayfaları resme çevirip
//      sunucudaki "ocr" ile okutur. Sonuç materyalin içine kaydedilir: aynı dosya ikinci kez okunmaz.
//   2. pickContext: soruya en çok benzeyen parçaları seçer (her soruda kitabın tamamı gönderilemez,
//      dakikalık sınır küçük). Basit bir arama: kelime eşleşmesi + nadir kelimelere daha çok puan.
//      C++ benzetmesi: her parçaya bir skor ver, std::sort ile sırala, bütçe dolana kadar baştan al.

import { aiFetch, spent } from "./aiApi";
import { savePages, type Material } from "./study";

const MIN_TEXT = 40; // bir sayfada bundan az harf varsa "taranmış" say, resimden oku

/** Sayfa görüntüsünü sunucuya okutur. Dakikalık sınıra takılırsa biraz bekleyip yeniden dener. */
async function ocrImage(dataUrl: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await aiFetch("ocr", JSON.stringify({ image: dataUrl }));
    if (res.ok) {
      spent("ocr");
      return ((await res.json()) as { text?: string }).text ?? "";
    }
    const err = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "";
    if (err === "daily-limit") throw new Error("ocr-daily-limit");
    if (err !== "rate-limit") throw new Error(err || "ocr");
    await new Promise((r) => setTimeout(r, 20_000 * (attempt + 1)));
  }
  throw new Error("rate-limit");
}

async function canvasToJpeg(canvas: HTMLCanvasElement): Promise<string> {
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function blobToJpeg(blob: Blob, max = 1600): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvasToJpeg(canvas);
}

const running = new Map<string, Promise<string[]>>();

/**
 * Materyalin sayfa yazıları (önce kayıtlıya bakar). onProgress(okunan, toplam) ilerlemeyi gösterir.
 * Aynı materyal için aynı anda iki kez çalışmaz.
 */
export function extractPages(m: Material, onProgress?: (done: number, total: number) => void): Promise<string[]> {
  if (m.pages && m.pages.length) return Promise.resolve(m.pages);
  const existing = running.get(m.id);
  if (existing) return existing;
  const p = (async () => {
    let pages: string[];
    if (m.mimeType === "application/pdf") {
      try {
        pages = await pdfPages(m.file, onProgress);
      } catch (err) {
        // Günlük okuma hakkı bitti: okunabilen kısmı şimdilik kullan ama KAYDETME (yarın tamamı okunsun).
        const partial = (err as { partial?: string[] }).partial;
        if (partial) return partial;
        throw err;
      }
    } else if (m.mimeType.startsWith("image/")) {
      onProgress?.(0, 1);
      pages = [await ocrImage(await blobToJpeg(m.file))];
      onProgress?.(1, 1);
    } else {
      // Düz metin: yaklaşık 3000 harflik "sayfalar"a böl.
      const text = await m.file.text();
      pages = [];
      for (let i = 0; i < text.length; i += 3000) pages.push(text.slice(i, i + 3000));
      if (!pages.length) pages = [""];
    }
    await savePages(m.id, pages);
    return pages;
  })().finally(() => running.delete(m.id));
  running.set(m.id, p);
  return p;
}

export function isExtracting(id: string): boolean {
  return running.has(id);
}

async function pdfPages(file: Blob, onProgress?: (done: number, total: number) => void): Promise<string[]> {
  // pdf.js büyük bir kütüphane: yalnız gerekince yükle (dinamik import).
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress?.(n - 1, doc.numPages);
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = content.items
      .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : ""))
      .join("")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (text.replace(/\s/g, "").length < MIN_TEXT) {
      // Taranmış sayfa: ~1400 px genişliğinde resme çevirip okut.
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2.5, 1400 / base.width) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
      try {
        text = await ocrImage(await canvasToJpeg(canvas));
      } catch (err) {
        if (err instanceof Error && err.message === "ocr-daily-limit") {
          // Bugünlük okuma hakkı bitti: kalan sayfaları boş bırak (yarın yeniden denenebilir).
          pages.push("");
          for (let k = n + 1; k <= doc.numPages; k++) pages.push("");
          throw Object.assign(new Error("ocr-daily-limit"), { partial: pages });
        }
        throw err;
      }
      page.cleanup();
    }
    pages.push(text);
  }
  onProgress?.(doc.numPages, doc.numPages);
  await doc.destroy();
  return pages;
}

// ---------- Alıntı seçme ----------

const STOP = new Set(
  (
    "ve ile bir bu şu o da de mi mu ne için gibi daha çok en ama veya ya ki ise olan olarak bunu şunu bana beni sen " +
    "nasıl neden niye nedir hangi kaç var yok çöz anlat açıkla soru sorusu cevap " +
    "der die das und oder ein eine einer ist sind mit von zu im in auf für den dem des nicht als auch sich " +
    "the and or of to in is are for with on as by be this that what how why which"
  ).split(" "),
);

/** Kelimeleri sadeleştir: küçük harf, aksansız, en fazla 6 harflik kök (Türkçe/Almanca ekleri kabaca atılır). */
function terms(text: string): string[] {
  return text
    .toLocaleLowerCase("tr")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => w.slice(0, 6));
}

interface Chunk {
  label: string;
  text: string;
  order: number;
}

/** "Aufgabe 3", "3. soru", "Question 3", "Problem 3"... gibi soru numaralarını bul. */
function questionNumbers(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/(?:aufgabe|soru|question|problem|exercise|übung|ubung|task|frage)\s*(\d+)|(\d+)\s*\.?\s*(?:soru|aufgabe)/gi))
    out.push(m[1] ?? m[2]);
  return out;
}

/**
 * Seçili materyallerden soruya en uygun parçaları seçer, toplam ~budget harf.
 * Döndürdüğü metin her parçanın başında [dosya, s. N] etiketi taşır.
 */
export function pickContext(mats: { name: string; pages: string[] }[], question: string, budget = 9000): string {
  const chunks: Chunk[] = [];
  let order = 0;
  for (const m of mats)
    m.pages.forEach((page, i) => {
      for (let k = 0; k < page.length; k += 1200) {
        const text = page.slice(Math.max(0, k - 100), k + 1200).trim(); // biraz örtüşme: cümle ortadan bölünmesin
        if (text) chunks.push({ label: `[${m.name}, s. ${i + 1}]`, text, order: order++ });
      }
    });
  if (!chunks.length) return "";

  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  // Hepsi sığıyorsa seçmeye gerek yok.
  const pick = (list: Chunk[]) => {
    const out: Chunk[] = [];
    let used = 0;
    for (const c of list) {
      if (used + c.text.length > budget) continue;
      out.push(c);
      used += c.text.length;
    }
    return out.sort((a, b) => a.order - b.order).map((c) => `${c.label}\n${c.text}`).join("\n\n");
  };
  if (total <= budget) return pick(chunks);

  // Nadir kelimeler daha değerli (IDF): "Mittelwertsatz" geçen parça, "fonksiyon" geçenden daha önemli.
  const docs = chunks.map((c) => new Set(terms(c.text)));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(terms(question))];
  const nums = questionNumbers(question);
  const scores = chunks.map((c, i) => {
    let s = 0;
    for (const t of q) if (docs[i].has(t)) s += Math.log(1 + chunks.length / (df.get(t) ?? 1));
    for (const n of nums)
      if (new RegExp(`(?:aufgabe|soru|question|problem|exercise|übung|task|frage)\\s*${n}\\b|^\\s*${n}\\s*[.)]`, "im").test(c.text)) s += 8;
    return s;
  });
  const ranked = chunks
    .map((c, i) => ({ c, s: scores[i] }))
    .sort((a, b) => b.s - a.s || a.c.order - b.c.order);
  // Hiç eşleşme yoksa (ör. "özetle") baştan başla: kitabın girişi en iyi tahmin.
  if (ranked[0].s === 0) return pick(chunks);
  // En iyi parçaların hemen arkasındaki parçayı da ekle (soru bir sonraki parçada devam ediyor olabilir).
  const chosen: Chunk[] = [];
  for (const { c, s } of ranked) {
    if (s === 0) break;
    chosen.push(c);
    const next = chunks[c.order + 1];
    if (next && !chosen.includes(next)) chosen.push(next);
  }
  return pick(chosen);
}
