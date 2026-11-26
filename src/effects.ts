// Görsel ve sesli efektler: konfeti, kısa bildirim (toast) ve bitiş sesi.
// Hiçbir ek kütüphane kullanmıyoruz, hepsi tarayıcının kendi özellikleriyle.

/** Ekranın üstünden dökülen konfeti. Yaklaşık 3 saniye sürer. */
export function confetti(): void {
  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  const colors = ["#ff7a18", "#ffd166", "#10b981", "#60a5fa", "#f472b6"];
  // Her parçacık: konum (x, y), hız (vx, vy), dönüş açısı, renk
  const pieces = Array.from({ length: 160 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    vx: (Math.random() - 0.5) * 4,
    vy: 2 + Math.random() * 4,
    angle: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  function frame(now: number) {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = Math.max(0, 1 - t / 3000);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05; // yerçekimi
      p.angle += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-4, -7, 8, 14);
      ctx.restore();
    }
    if (t < 3000) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

/** Ekranın altında birkaç saniye görünen kısa mesaj. alert() yerine. */
export function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("hide"), 3000);
  setTimeout(() => el.remove(), 3500);
}

/** Süre bitince çalan kısa "dıt dıt dıt" sesi. */
export function chime(): void {
  try {
    const audio = new AudioContext();
    [0, 0.25, 0.5].forEach((delay, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = i === 2 ? 1046 : 784; // son nota daha tiz
      gain.gain.setValueAtTime(0.2, audio.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + delay + 0.22);
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + delay);
      osc.stop(audio.currentTime + delay + 0.25);
    });
  } catch {
    // Ses çalınamazsa sorun değil, sessizce geç.
  }
}
