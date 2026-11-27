// Birkaç dosyanın ortak kullandığı küçük yardımcılar (eskiden main.ts içindeydi).

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatMinutes(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} dk`;
  return m === 0 ? `${h} sa` : `${h} sa ${m} dk`;
}

/** Proje adından sabit bir renk (her proje hep aynı renkte görünsün). */
export function projectColor(name: string): string {
  const palette = ["#7dd3fc", "#818cf8", "#c084fc", "#f472b6", "#ff9a3c", "#ffd166", "#34d399", "#60a5fa"];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/** Gece yarısından beri geçen dakikayı "09:05" gibi yazar. */
export function clockText(minOfDay: number): string {
  const h = Math.floor(minOfDay / 60) % 24;
  const m = minOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
