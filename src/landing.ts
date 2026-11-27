// Giriş (tanıtım) sayfası. Uygulamanın üstüne tam ekran bir katman olarak açılır.
// - İlk ziyarette kendiliğinden görünür; "Uygulamayı aç" denince bir daha kendiliğinden açılmaz.
// - Telefona kurulmuş (ana ekrandan açılan) uygulamada hiç kendiliğinden açılmaz.
// - Üst çubuktaki logoya tıklayınca ya da adrese ?tanitim eklenince yeniden açılır.
import "./landing.css";

const SEEN_KEY = "gazzla.seenLanding";

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* gizli sekme vb. — önemli değil */
  }
}

const FEATURES = [
  {
    icon: "⏱️",
    title: "Kaymayan zamanlayıcı",
    text: "Bitiş anını tutar; sekme arka planda kalsa da, telefon kilitlense de süre şaşmaz.",
  },
  {
    icon: "🎯",
    title: "Projeler ve hedefler",
    text: "Her proje için istersen haftalık hedef koy, ilerleme çubuğu dolarken izle.",
  },
  {
    icon: "👥",
    title: "Arkadaşlarla birlikte",
    text: "Kim şu an çalışıyor, kim arada, gör. Toplam süreler görünür; proje adların gizli kalır.",
  },
  {
    icon: "🔄",
    title: "Her cihazda aynı",
    text: "Önce cihazına yazar, giriş yaptıysan arka planda buluta eşitler. İnternet gitse de kayıp yok.",
  },
  {
    icon: "🔥",
    title: "Gaz ve seri",
    text: "Seans bitince konfeti, hedefi tutturdukça uzayan seri. Bırakmamak için küçük bir itici güç.",
  },
  {
    icon: "📊",
    title: "Net istatistik",
    text: "Gün, hafta, proje bazında ne kadar çalıştığını tek bakışta gör.",
  },
];

const MARQUEE = [
  "Telefon kenara, odak sende.",
  "Bir tuğla daha koydun.",
  "Seans bitti, gaz bitmedi.",
  "Bırakma, akıştasın.",
  "Küçük adımlar, büyük sınavlar.",
  "Hedef cepte!",
];

function landingHtml(): string {
  const marquee = [...MARQUEE, ...MARQUEE]
    .map((m) => `<span>${m}</span><i>✦</i>`)
    .join("");
  return `
  <div class="lp-bg" aria-hidden="true">
    <div class="lp-blob b1"></div><div class="lp-blob b2"></div><div class="lp-blob b3"></div>
    <div class="lp-grid"></div>
  </div>

  <nav class="lp-nav">
    <a class="lp-brand" href="#" data-lp-top><img src="/logo.svg" alt="" /><span>Gazzla</span></a>
    <div class="lp-nav-links">
      <a href="#lp-features">Özellikler</a>
      <a href="#lp-how">Nasıl çalışır</a>
    </div>
    <button class="lp-btn small" data-lp-open>Uygulamayı aç</button>
  </nav>

  <section class="lp-hero">
    <div class="lp-hero-text">
      <div class="lp-pill"><span class="dot"></span> Arkadaşlarınla birlikte odaklan</div>
      <h1>Odaklan.<br /><span class="lp-grad">Gazzla.</span><br />Birlikte bitir.</h1>
      <p class="lp-lead">
        Gazzla; seanslarını sayan, projelerini takip eden ve arkadaşlarınla aynı anda çalıştığını
        gösteren sade bir çalışma zamanlayıcısı.
      </p>
      <div class="lp-ctas">
        <button class="lp-btn" data-lp-open>Hemen başla <span class="arrow">→</span></button>
        <a class="lp-btn ghost" href="#lp-features">Neler var?</a>
      </div>
      <p class="lp-note">Kayıt şart değil · Ücretsiz · Telefona kurulabilir</p>
    </div>

    <div class="lp-hero-visual" aria-hidden="true">
      <div class="lp-orbit"></div>
      <div class="lp-ring">
        <svg viewBox="0 0 200 200">
          <defs>
            <linearGradient id="lpRingGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#7dd3fc" />
              <stop offset="0.5" stop-color="#6366f1" />
              <stop offset="1" stop-color="#ff7a18" />
            </linearGradient>
          </defs>
          <circle cx="100" cy="100" r="86" class="track" />
          <circle cx="100" cy="100" r="86" class="bar" id="lp-ring-bar" />
        </svg>
        <div class="lp-ring-center">
          <div class="lp-ring-time" id="lp-ring-time">25:00</div>
          <div class="lp-ring-label">odak</div>
        </div>
      </div>
      <div class="lp-float f1"><span class="av">E</span><div><b>Elif</b><small><i class="live"></i>çalışıyor · 42 dk</small></div></div>
      <div class="lp-float f2"><div class="big">🔥 5</div><small>günlük seri</small></div>
      <div class="lp-float f3"><small>Bu hafta</small><b>6 sa 20 dk</b><div class="mini-bar"><span></span></div></div>
    </div>
  </section>

  <div class="lp-marquee" aria-hidden="true"><div class="lp-marquee-track">${marquee}</div></div>

  <section class="lp-stats lp-reveal">
    <div><b>25<small>dk</small></b><span>klasik odak seansı</span></div>
    <div><b>0</b><span>reklam, takip, abonelik</span></div>
    <div><b>∞</b><span>proje ve seans</span></div>
    <div><b>1</b><span>dokunuşla başla</span></div>
  </section>

  <section class="lp-section" id="lp-features">
    <div class="lp-section-head lp-reveal">
      <span class="lp-kicker">Özellikler</span>
      <h2>Çalışmak için gereken her şey,<br /><span class="lp-grad">fazlası değil.</span></h2>
    </div>
    <div class="lp-cards">
      ${FEATURES.map(
        (f, i) => `
        <article class="lp-card lp-reveal" style="--d:${i * 70}ms">
          <div class="lp-card-icon">${f.icon}</div>
          <h3>${f.title}</h3>
          <p>${f.text}</p>
        </article>`,
      ).join("")}
    </div>
  </section>

  <section class="lp-section" id="lp-how">
    <div class="lp-section-head lp-reveal">
      <span class="lp-kicker">Nasıl çalışır</span>
      <h2>Üç adımda akışa gir.</h2>
    </div>
    <ol class="lp-steps">
      <li class="lp-reveal" style="--d:0ms"><span class="n">01</span><h3>Projeni seç</h3><p>Ders, ödev, kod… Ne üzerinde çalışacaksan ekle; istersen haftalık hedef koy.</p></li>
      <li class="lp-reveal" style="--d:90ms"><span class="n">02</span><h3>Sayacı başlat</h3><p>Telefonu kenara bırak. Sayaç sen dönene kadar doğru zamanı tutar.</p></li>
      <li class="lp-reveal" style="--d:180ms"><span class="n">03</span><h3>Gazı al</h3><p>Seans bitince konfeti, seri uzar, arkadaşların toplamına eklenir.</p></li>
    </ol>
  </section>

  <section class="lp-final lp-reveal">
    <div class="lp-final-glow" aria-hidden="true"></div>
    <img src="/logo.svg" alt="" class="lp-final-logo" />
    <h2>Bir sonraki seans<br /><span class="lp-grad">şimdi başlıyor.</span></h2>
    <button class="lp-btn" data-lp-open>Uygulamayı aç <span class="arrow">→</span></button>
  </section>

  <footer class="lp-footer">
    <span>Gazzla · kendimiz ve arkadaşlarımız için yapıldı</span>
    <a href="#" data-lp-top>Başa dön ↑</a>
  </footer>`;
}

let root: HTMLElement | null = null;
let timerHandle: number | undefined;
let observer: IntersectionObserver | undefined;

/** Sağdaki örnek halkada süre hızlıca akar (gerçek sayaç değil, sadece görüntü). */
function startDemoRing(el: HTMLElement): void {
  const bar = el.querySelector<SVGCircleElement>("#lp-ring-bar");
  const time = el.querySelector<HTMLElement>("#lp-ring-time");
  if (!bar || !time) return;
  const circumference = 2 * Math.PI * 86;
  bar.style.strokeDasharray = `${circumference}`;
  const total = 25 * 60;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let left = reduce ? 17 * 60 + 32 : total;
  const draw = () => {
    const m = Math.floor(left / 60);
    const s = left % 60;
    time.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    bar.style.strokeDashoffset = `${circumference * (1 - left / total)}`;
  };
  draw();
  if (reduce) return;
  timerHandle = window.setInterval(() => {
    left = left <= 0 ? total : left - 7;
    if (left < 0) left = 0;
    draw();
  }, 60);
}

export function openLanding(): void {
  if (root) return;
  root = document.createElement("div");
  root.className = "lp";
  root.innerHTML = landingHtml();
  document.body.appendChild(root);
  document.body.classList.add("lp-open");

  root.querySelectorAll("[data-lp-open]").forEach((b) =>
    b.addEventListener("click", () => closeLanding()),
  );
  root.querySelectorAll("[data-lp-top]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      root?.scrollTo({ top: 0, behavior: "smooth" });
    }),
  );
  // Sayfa içi bağlantılar (#lp-features vb.): katmanın kendi kaydırmasıyla git.
  root.querySelectorAll<HTMLAnchorElement>('a[href^="#lp-"]').forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      root?.querySelector(a.getAttribute("href")!)?.scrollIntoView({ behavior: "smooth" });
    }),
  );

  // Üst çubuk kayınca arka planı koyulaşsın.
  const nav = root.querySelector<HTMLElement>(".lp-nav")!;
  const el = root; // kapanırken root null olur; kaydırma olayı yine de gelebilir
  el.addEventListener("scroll", () => nav.classList.toggle("scrolled", el.scrollTop > 20), {
    passive: true,
  });

  // Kaydırdıkça bölümler yumuşakça belirsin.
  observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          observer?.unobserve(en.target);
        }
      }),
    { root, threshold: 0.15 },
  );
  root.querySelectorAll(".lp-reveal").forEach((el) => observer!.observe(el));

  startDemoRing(root);
}

export function closeLanding(): void {
  if (!root) return;
  markSeen();
  const el = root;
  root = null;
  window.clearInterval(timerHandle);
  observer?.disconnect();
  el.classList.add("closing");
  document.body.classList.remove("lp-open");
  el.addEventListener("animationend", () => el.remove(), { once: true });
  // Animasyon kapalıysa animationend gelmez; yedek olarak kısa süre sonra kaldır.
  window.setTimeout(() => el.remove(), 700);
  // Adresteki ?tanitim'i temizle ki yenileyince tekrar açılmasın.
  const url = new URL(location.href);
  if (url.searchParams.has("tanitim")) {
    url.searchParams.delete("tanitim");
    history.replaceState(null, "", url);
  }
}

export function initLanding(): void {
  const forced = new URLSearchParams(location.search).has("tanitim");
  if (forced || (!hasSeen() && !isStandalone())) openLanding();

  // Uygulamanın üst çubuğundaki logoya tıklayınca tanıtımı yeniden aç.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#app header .logo-mark, #app header .logo")) openLanding();
  });
}
