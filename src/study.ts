// "Ders asistanı" modunun verisi: kullanıcının yüklediği materyaller (PDF, resim, metin).
//
// Dosyalar bu cihazda IndexedDB'de duruyor. localStorage birkaç MB'ı kaldırmaz; IndexedDB tarayıcının
// büyük veriler (Blob'lar dahil) için olan veritabanı. Buluta ya da arkadaşlara gitmez.
// Soru sorulunca işaretli materyaller /api/study/upload ile servise yüklenir (orada ~48 saat kalır,
// süresi dolunca kendiliğinden yeniden yüklenir) ve soruya "şu dosyalara bak" diye eklenir.

export interface Material {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  addedAt: number;
  active: boolean; // soru sorarken kullanılsın mı (işaret kutusu)
  file: Blob;
  remote?: { uri: string; mimeType: string; expiresAt: number }; // servisteki kopya
}

export const ACCEPT = ".pdf,.txt,.md,.csv,image/png,image/jpeg,image/webp,image/heic,image/heif";
export const MAX_SIZE = 50 * 1024 * 1024;

// ---------- IndexedDB (küçük bir sarmalayıcı) ----------
// IndexedDB eski tarz "olay" (callback) arayüzü kullanıyor; Promise'e çeviriyoruz ki await yazabilelim.

const DB_NAME = "gazzla-study";
const STORE = "materials";

let dbPromise: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// Bellekteki kopya (ekranı her çizişte veritabanına gitmeyelim). undefined = henüz yüklenmedi.
let cache: Material[] | undefined;

export async function loadMaterials(): Promise<Material[]> {
  if (!cache) {
    try {
      cache = ((await tx("readonly", (s) => s.getAll())) as Material[]).sort((a, b) => a.addedAt - b.addedAt);
    } catch {
      cache = [];
    }
  }
  return cache;
}

/** Bellekteki liste (yüklenmediyse boş). Ekranı çizmek için. */
export function materialsNow(): Material[] | undefined {
  return cache;
}

async function save(m: Material): Promise<void> {
  await tx("readwrite", (s) => s.put(m));
  const list = await loadMaterials();
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m;
  else list.push(m);
}

export async function addMaterial(file: File): Promise<Material> {
  const m: Material = {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || guessType(file.name),
    size: file.size,
    addedAt: Date.now(),
    active: true,
    file,
  };
  await save(m);
  return m;
}

export async function setActive(id: string, active: boolean): Promise<void> {
  const m = (await loadMaterials()).find((x) => x.id === id);
  if (m) await save({ ...m, active });
}

export async function removeMaterial(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
  cache = (await loadMaterials()).filter((x) => x.id !== id);
}

function guessType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    { pdf: "application/pdf", txt: "text/plain", md: "text/plain", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] ??
    "application/octet-stream"
  );
}

// ---------- Servise yükleme ----------

const uploading = new Map<string, Promise<Material>>();

/** Materyal serviste yoksa ya da süresi bir saat içinde doluyorsa yükler. Aynı anda iki kez yüklemez. */
export function ensureUploaded(m: Material, force = false): Promise<Material> {
  if (!force && m.remote && m.remote.expiresAt - Date.now() > 3600_000) return Promise.resolve(m);
  const running = uploading.get(m.id);
  if (running) return running;
  const p = (async () => {
    const res = await fetch("/api/study/upload", {
      method: "POST",
      headers: { "Content-Type": m.mimeType },
      body: m.file,
    });
    const json = (await res.json().catch(() => ({}))) as { uri?: string; mimeType?: string; expiresAt?: number; error?: string };
    if (!res.ok || !json.uri) throw new Error(json.error ?? "upload");
    const updated: Material = { ...m, remote: { uri: json.uri, mimeType: json.mimeType ?? m.mimeType, expiresAt: json.expiresAt ?? Date.now() + 47 * 3600_000 } };
    // Bu arada silindiyse geri kaydetme.
    if ((await loadMaterials()).some((x) => x.id === m.id)) await save(updated);
    return updated;
  })().finally(() => uploading.delete(m.id));
  uploading.set(m.id, p);
  return p;
}

export function isUploading(id: string): boolean {
  return uploading.has(id);
}

// ---------- Görsel küçültme ----------

/** Sohbete eklenen fotoğrafı en fazla 1600 px'e küçültüp JPEG "data URL" yapar (istek hafif kalsın). */
export async function imageToDataUrl(file: Blob, max = 1600): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
