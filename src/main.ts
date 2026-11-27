// Uygulamanın giriş noktası: ekranı çizer ve düğmeleri bağlar.
// Akış: süre gir → çalış → bitince ara mı, yeni seans mı?

import "./style.css";
import { initLanding } from "./landing";
import { CountdownTimer } from "./timer";
import {
  addSession,
  currentStreak,
  addSubject,
  loadSubjects,
  removeSubject,
  renameSubject,
  lastSevenDays,
  loadSettings,
  saveSettings,
  statsBySubject,
  weekPauseCount,
  todayWorkMinutes,
  weekWorkMinutes,
  subjectGoal,
  setSubjectGoal,
  GENERAL,
} from "./storage";
import { hype } from "./hype";
import { chime, confetti, toast } from "./effects";
import { sync } from "./sync";
import {
  acceptRequest,
  clearPresence,
  getMyProfile,
  isActive,
  loadActiveFriends,
  loadFriendsOverview,
  removeFriendship,
  saveUsername,
  sendFriendRequest,
  setPresence,
  type FriendsOverview,
  type Presence,
  type Profile,
} from "./friends";
import {
  getCurrentUser,
  onAuthChange,
  signIn,
  signOut,
  signUp,
  type AuthUser,
} from "./supabase";
import type { Session } from "./types";

type Phase = "idle" | "work" | "break" | "askNext";

const app = document.querySelector<HTMLElement>("#app")!;
const settings = loadSettings();
let phase: Phase = "idle";
let view: "timer" | "stats" | "goals" | "subjects" | "account" | "friends" = "timer";
let goalsEdit: string | undefined; // hedefler sayfasında düzenlenen: "daily", "weekly" ya da "p:<proje>"
// Arkadaşlar
let myProfile: Profile | null | undefined; // undefined = henüz yüklenmedi, null = kullanıcı adı yok
let friendsData: FriendsOverview | undefined;
let friendsError: string | undefined;
let confirmRemoveFriend: string | undefined; // çıkarılmak üzere onay bekleyen arkadaşın id'si
let activeFriends: (Profile & { presence: Presence })[] = []; // şu an aktif arkadaşlar
let authUser: AuthUser | null = null; // giriş yapılmamışsa null
let authMode: "signin" | "signup" = "signin"; // hesap ekranında giriş mi kayıt mı gösteriliyor
let authBusy = false; // istek giderken butonlar kilitli olsun (iki kez basılmasın)
let syncState: "idle" | "syncing" | "error" = "idle";
let syncError: string | undefined;
let lastSyncAt: number | undefined;
let editingSubject: string | undefined; // adı değiştirilen ders
let confirmDelete: string | undefined; // silinmek üzere onay bekleyen ders
let currentSubject: string | undefined = settings.lastSubject; // en son seçilen ders hatırlanır
let phaseTotalMs = 0; // şu anki seansın toplam süresi (halkayı doldurmak için)
let hypeMessage = hype.start(settings.userName);
let hypeInterval: number | undefined;
type GoalKind = "daily" | "weekly" | "subject";
let editingGoal: GoalKind | undefined; // hangi hedef düzenleniyor (yoksa hiçbiri)
// Ders modu: sol menüden bir derse girildiyse o dersin adı. Bu modda zamanlayıcı o derse kilitlenir
// ve ekranda o dersin hedefi ve istatistikleri görünür. undefined = ana ekran.
let focusSubject: string | undefined;
let menuOpen = false;

// Halkanın çevresi: 2 * pi * r. SVG'de r = 110.
const RING_CIRCUMFERENCE = 2 * Math.PI * 110;

const timer = new CountdownTimer(
  (remainingMs) => updateRunningView(remainingMs),
  () => finishPhase(),
);

// ---------- Yardımcılar ----------

function formatTime(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function saveCurrent(kind: Session["kind"], durationMs: number): void {
  if (durationMs < 1000) return; // yanlışlıkla basılanları kaydetme
  addSession({
    id: crypto.randomUUID(),
    kind,
    startedAt: timer.startTime,
    durationMs,
    subject: kind === "work" ? currentSubject : undefined,
    pauseCount: timer.pauseCount || undefined,
  });
  runSync(); // giriş yapılmışsa hemen buluta yükle
}

function notify(message: string): void {
  chime();
  toast(message);
  // Sekme arka plandaysa sistem bildirimi de gönder.
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification("Gazzla", { body: message });
  }
}

// ---------- Akış ----------

function startPhase(kind: "work" | "break", minutes: number): void {
  phase = kind;
  phaseTotalMs = minutes * 60_000;
  hypeMessage = kind === "work" ? hype.start(settings.userName) : "Mola zamanı. Kalk, su iç, gözlerini dinlendir.";
  render(); // önce ekranı çiz, sonra sayacı başlat (yoksa saat yazacak yer olmaz)
  timer.start(minutes);
  publishPresence();
  refreshTogether();
}

/** Süre kendiliğinden dolduğunda. */
function finishPhase(): void {
  const kind = phase === "break" ? "break" : "work";
  const before = todayWorkMinutes();
  const weekBefore = weekWorkMinutes();
  // Seansın dersinin hedefi varsa, onun da öncesini al.
  const subj = kind === "work" ? currentSubject : undefined;
  const subjGoal = subj ? subjectGoal(subj) : undefined;
  const subjBefore = subj ? weekWorkMinutes(subj) : 0;
  saveCurrent(kind, timer.stop());
  if (authUser) clearPresence(authUser.id);

  if (kind === "work") {
    const goalJustMet = before < settings.dailyGoalMin && todayWorkMinutes() >= settings.dailyGoalMin;
    const weekJustMet = weekBefore < settings.weeklyGoalMin && weekWorkMinutes() >= settings.weeklyGoalMin;
    const subjJustMet =
      subj !== undefined && subjGoal !== undefined && subjBefore < subjGoal && weekWorkMinutes(subj) >= subjGoal;
    // Önem sırası: genel haftalık > ders haftalık > günlük. Sadece en önemlisinin mesajı çıkar.
    hypeMessage = weekJustMet
      ? hype.weekGoalMet(settings.userName)
      : subjJustMet
        ? hype.subjectGoalMet(settings.userName, subj!)
        : goalJustMet
          ? hype.goalMet(settings.userName)
          : hype.done(settings.userName);
    notify(hypeMessage);
    confetti();
    if (goalJustMet || weekJustMet || subjJustMet) setTimeout(confetti, 700); // hedef tuttuysa ekstra konfeti
    if (weekJustMet) setTimeout(confetti, 1400); // haftalık hedefte bir tur daha
  } else {
    hypeMessage = hype.breakOver(settings.userName);
    notify(hypeMessage);
  }
  phase = "askNext";
  render();
}

/** Süre dolmadan elle bitirmek. Geçen kısım yine kaydedilir. */
function stopEarly(): void {
  const kind = phase === "break" ? "break" : "work";
  saveCurrent(kind, timer.stop());
  if (authUser) clearPresence(authUser.id);
  hypeMessage = kind === "work" ? "Kaydedildi. Sırada ne var?" : "Ara erken bitti, iyi iş!";
  phase = "askNext";
  render();
}

/** Süreyi soracak mı, ayarlardaki sabit süreyi mi kullanacak? */
function askMinutes(kind: "work" | "break"): void {
  const def = kind === "work" ? settings.defaultWorkMin : settings.defaultBreakMin;
  if (settings.fixedDurations) {
    startPhase(kind, def);
    return;
  }
  const input = document.querySelector<HTMLInputElement>("#minutes");
  const minutes = Number(input?.value);
  if (!minutes || minutes <= 0) {
    toast("Geçerli bir süre gir (dakika).");
    return;
  }
  startPhase(kind, minutes);
}

// ---------- Ekran ----------

/** Sayaç çalışırken her tik'te sadece değişen yerleri güncelle. */
function updateRunningView(remainingMs: number): void {
  const clock = document.querySelector("#clock");
  if (clock) clock.textContent = formatTime(remainingMs);

  const ring = document.querySelector<SVGCircleElement>("#ring-progress");
  if (ring && phaseTotalMs > 0) {
    const done = 1 - remainingMs / phaseTotalMs;
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - done));
  }

  // Çalışırken hedef çubuğu da canlı dolsun.
  if (phase === "work") {
    const elapsedMin = (phaseTotalMs - remainingMs) / 60000;
    updateGoalBars(elapsedMin);
  }
}

/** Hedefin dakikası ve şu ana kadar yapılan (kayıtlı) dakika. */
function goalInfo(kind: GoalKind): { goal: number; done: number } {
  if (kind === "daily") return { goal: settings.dailyGoalMin, done: todayWorkMinutes() };
  if (kind === "weekly") return { goal: settings.weeklyGoalMin, done: weekWorkMinutes() };
  // Ders hedefi: hedef yoksa (henüz koyulmamışsa) 0 döner, çağıran taraf bunu kontrol eder.
  return { goal: subjectGoal(focusSubject!) ?? 0, done: weekWorkMinutes(focusSubject) };
}

/** Ekranda hangi hedef satırları var: ders modunda ve dersin hedefi varsa üçüncü satır da. */
function visibleGoals(): GoalKind[] {
  const kinds: GoalKind[] = ["daily", "weekly"];
  if (focusSubject && subjectGoal(focusSubject) !== undefined) kinds.push("subject");
  return kinds;
}

/**
 * İki hedef çubuğunu da günceller.
 * extraMin: henüz kaydedilmemiş, şu an süren seansta geçen dakika (çalışırken canlı dolsun diye).
 */
function updateGoalBars(extraMin = 0): void {
  for (const kind of visibleGoals()) {
    const { goal, done } = goalInfo(kind);
    const minutes = done + extraMin;
    const fill = document.querySelector<HTMLElement>(`#goal-fill-${kind}`);
    const label = document.querySelector(`#goal-label-${kind}`);
    if (fill) fill.style.width = `${Math.min(100, (minutes / goal) * 100)}%`;
    // Günlük dakika olarak, haftalık saat+dakika olarak daha okunaklı.
    if (label) {
      label.textContent =
        kind === "daily"
          ? `${Math.floor(minutes)} / ${goal} dk`
          : `${formatMinutes(Math.floor(minutes))} / ${formatMinutes(goal)}`;
    }
  }
}

/** Üst çubuktaki sade çizgi ikonlar (renk yazı renginden gelir, emoji gibi sırıtmaz). */
const svgIcon = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  menu: svgIcon('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  chart: svgIcon('<path d="M5 20V11M12 20V5M19 20v-6"/>'),
  timer: svgIcon('<circle cx="12" cy="13" r="7"/><path d="M12 10v3l2 2M10 3h4"/>'),
};

function headerHtml(): string {
  const streak = currentStreak(settings.dailyGoalMin);
  return `
    <header>
      <div class="header-left">
        <button id="open-menu" class="icon round" title="Menü" aria-label="Menü">${ICONS.menu}</button>
        <img class="logo-mark" src="/logo.svg" alt="" /><h1 class="logo">Gazzla</h1>
      </div>
      <div class="header-right">
        <div class="streak ${streak > 0 ? "on" : ""}" title="Üst üste hedef tutturduğun gün sayısı">
          🔥 ${streak} gün
        </div>
        <button id="toggle-view" class="icon round" title="${view === "timer" ? "İstatistikler" : "Zamanlayıcı"}"
          aria-label="${view === "timer" ? "İstatistikler" : "Zamanlayıcı"}">
          ${view === "timer" ? ICONS.chart : ICONS.timer}
        </button>
      </div>
    </header>`;
}

/** Tek bir hedef satırı: başlık, sağda "x / y" (ya da düzenleme kutusu), altında çubuk. */
function goalRowHtml(kind: GoalKind): string {
  const { goal, done } = goalInfo(kind);
  const met = done >= goal;
  const title =
    kind === "daily"
      ? "Günlük hedef"
      : kind === "weekly"
        ? "Haftalık hedef"
        : `${escapeHtml(focusSubject!)} · haftalık`;
  const canEdit = phase === "idle" || phase === "askNext";
  // Etiket metnini updateGoalBars() dolduruyor; burada boş bırakıyoruz.
  const control =
    editingGoal === kind
      ? `<span class="goal-edit">
           <input id="goal-input" type="number" min="1" value="${goal || 300}" /> dk
           <button id="goal-save" class="small">Kaydet</button>
           ${kind === "subject" ? `<button id="goal-remove" class="small ghost" title="Bu projenin hedefini kaldır">Kaldır</button>` : ""}
         </span>`
      : `<span id="goal-label-${kind}"></span>
         ${canEdit ? `<button class="icon goal-edit-btn" data-goal="${kind}" title="Hedefi değiştir">✎</button>` : ""}`;

  return `
    <div class="goal-row ${met ? "met" : ""} ${kind === "subject" ? "subject-goal" : ""}">
      <div class="goal-top">
        <span>${title} ${met ? "✅" : ""}</span>
        <span class="goal-right">${control}</span>
      </div>
      <div class="bar"><div id="goal-fill-${kind}" class="fill"></div></div>
    </div>`;
}

function goalHtml(): string {
  // Ders modunda: dersin hedefi varsa (ya da şu an koyuluyorsa) satırını göster,
  // yoksa sadece "hedef koy" butonu. Hedef koymak zorunlu değil.
  let subjectPart = "";
  if (focusSubject) {
    const hasGoal = subjectGoal(focusSubject) !== undefined;
    const canEdit = phase === "idle" || phase === "askNext";
    if (hasGoal || editingGoal === "subject") subjectPart = goalRowHtml("subject");
    else if (canEdit)
      subjectPart = `<button class="small ghost goal-edit-btn add-goal" data-goal="subject">
                       + ${escapeHtml(focusSubject)} için haftalık hedef koy
                     </button>`;
  }
  return `
    <section class="card goal">
      ${goalRowHtml("daily")}
      ${goalRowHtml("weekly")}
      ${subjectPart}
      <button class="goal-more" data-open-goals>Tüm hedefler →</button>
    </section>`;
}

function ringHtml(
  centerTop: string,
  centerBottom: string,
  kind: "work" | "break" | "idle",
  paused = false,
): string {
  return `
    <div class="ring-wrap ${kind} ${paused ? "paused" : ""}">
      <svg viewBox="0 0 240 240" class="ring">
        <defs>
          <linearGradient id="grad-work" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#7dd3fc" />
            <stop offset="50%" stop-color="#6366f1" />
            <stop offset="100%" stop-color="#ff7a18" />
          </linearGradient>
          <linearGradient id="grad-break" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#10b981" />
            <stop offset="100%" stop-color="#60a5fa" />
          </linearGradient>
        </defs>
        <circle cx="120" cy="120" r="110" class="ring-track" />
        <circle cx="120" cy="120" r="110" id="ring-progress" class="ring-progress"
          stroke-dasharray="${RING_CIRCUMFERENCE}"
          stroke-dashoffset="${RING_CIRCUMFERENCE}" />
      </svg>
      <div class="ring-center">
        <div id="clock" class="clock">${centerTop}</div>
        <div class="ring-sub">${paused ? "⏸ Duraklatıldı" : centerBottom}</div>
      </div>
    </div>`;
}

/** Bilgisayarda sağ sütun: bugünün özeti (telefonda gizli; orada hedef kartı yetiyor). */
function todaySideHtml(): string {
  return `
    <section class="card totals desk-only">
      <div><span class="muted">Bugün</span><strong>${formatMinutes(Math.floor(todayWorkMinutes()))}</strong></div>
      <div><span class="muted">Bu hafta</span><strong>${formatMinutes(Math.floor(weekWorkMinutes()))}</strong></div>
      <div><span class="muted">Seri</span><strong>${currentStreak(settings.dailyGoalMin)} gün</strong></div>
    </section>`;
}

/** Bilgisayarda sağ sütun: şu an aktif arkadaşlar. İçini updateTogetherLine() dolduruyor. */
function sideFriendsHtml(): string {
  if (!authUser) return "";
  return `
    <section class="card desk-only">
      <div class="card-title">Arkadaşlar şu an</div>
      <ul id="side-friends" class="side-friends"></ul>
    </section>`;
}

function render(): void {
  clearInterval(hypeInterval);
  const running = phase === "work" || phase === "break";
  // CSS bilgisayar görünümünde her sayfayı farklı diziyor (#app[data-view=...]).
  app.dataset.view = view;

  if (view === "stats") {
    renderStats();
  } else if (view === "goals") {
    renderGoals();
  } else if (view === "subjects") {
    renderSubjects();
  } else if (view === "account") {
    renderAccount();
  } else if (view === "friends") {
    renderFriends();
  } else if (running) {
    const subtitle =
      phase === "work" ? escapeHtml(currentSubject ?? "Genel çalışma") : "Ara";
    // .tl = iki sütunlu düzen (bilgisayarda). Telefonda sütunlar yok sayılır (display: contents),
    // kutular CSS'teki "order" ile eski sırasına (hedef kartı en üstte) dizilir.
    app.innerHTML = `
      ${headerHtml()}
      <div class="tl">
        <div class="tl-main">
          ${ringHtml(formatTime(timer.remainingMs), subtitle, phase as "work" | "break", timer.paused)}
          <p id="hype" class="hype">${escapeHtml(
            timer.paused ? "Duraklatıldı. İşini hallet, hemen dön!" : hypeMessage,
          )}</p>
          <p id="together" class="together"></p>
          <div class="row">
            ${
              timer.paused
                ? `<button id="resume" class="primary">Devam et ▶</button>`
                : `<button id="pause" class="secondary">Duraklat ⏸</button>`
            }
            <button id="stop" class="secondary">Bitir</button>
          </div>
          <p class="key-hint desk-only">Boşluk tuşu: ${timer.paused ? "devam et" : "duraklat"}</p>
        </div>
        <aside class="tl-side">
          ${goalHtml()}
          ${sideFriendsHtml()}
        </aside>
      </div>`;
    document.querySelector("#stop")!.addEventListener("click", stopEarly);
    document.querySelector("#pause")?.addEventListener("click", () => {
      timer.pause();
      publishPresence();
      render();
    });
    document.querySelector("#resume")?.addEventListener("click", () => {
      timer.resume();
      publishPresence();
      render();
    });

    // Çalışırken her dakika yeni bir gaz mesajı (duraklatılmışken değil).
    if (phase === "work" && !timer.paused) {
      hypeInterval = window.setInterval(() => {
        const el = document.querySelector("#hype");
        if (el) el.textContent = hype.working(settings.userName);
      }, 60_000);
    }
  } else {
    const askingNext = phase === "askNext";
    app.innerHTML = `
      ${headerHtml()}
      <div class="tl">
        <div class="tl-main">
          ${ringHtml(
            settings.fixedDurations ? formatTime(settings.defaultWorkMin * 60_000) : "Hazır",
            askingNext ? "Sırada ne var?" : "Bir seans başlat",
            "idle",
          )}
          <p class="hype">${escapeHtml(hypeMessage)}</p>
          <p id="together" class="together"></p>
          <section class="card form setup">
            ${settings.fixedDurations ? "" : durationHtml()}
            ${focusSubject ? lockedSubjectHtml() : subjectPickerHtml()}
          </section>
          <div class="row">
            <button id="work" class="primary">Gazla 🚀</button>
            ${askingNext ? `<button id="break" class="secondary">Ara ver ☕</button>` : ""}
          </div>
          <p class="key-hint desk-only">Boşluk tuşu: başlat</p>
        </div>
        <aside class="tl-side">
          ${goalHtml()}
          ${focusSubject ? "" : todaySideHtml()}
          ${sideFriendsHtml()}
          ${focusSubject ? `<div class="tl-stats">${subjectStatsHtml(focusSubject)}</div>` : ""}
        </aside>
      </div>`;

    document.querySelector("#new-project")?.addEventListener("click", openNewProjectModal);
    document.querySelectorAll<HTMLButtonElement>(".chip[data-subject]").forEach((chip) =>
      chip.addEventListener("click", () => {
        currentSubject = chip.dataset.subject || undefined; // "" = genel çalışma
        // Ekranı baştan çizmiyoruz (yoksa yazdığın süre silinir), sadece seçimi değiştiriyoruz.
        document
          .querySelectorAll(".chip[data-subject]")
          .forEach((c) => c.classList.toggle("selected", c === chip));
      }),
    );
    document.querySelector("#work")!.addEventListener("click", () => {
      if (focusSubject) {
        currentSubject = focusSubject; // ders modunda seans her zaman o derse yazılır
      } else {
        settings.lastSubject = currentSubject; // ana ekranda seçim hatırlansın
        saveSettings(settings);
      }
      askMinutes("work");
    });
    document.querySelector("#break")?.addEventListener("click", () => askMinutes("break"));
    bindDuration();
  }

  document.querySelector("#toggle-view")!.addEventListener("click", () => {
    view = view === "timer" ? "stats" : "timer";
    render();
  });
  document.querySelector("#open-menu")!.addEventListener("click", () => {
    menuOpen = true;
    renderMenu();
  });
  bindGoalEditing();
  updateGoalBars();
  updateTogetherLine();
  // Sayaç çalışıyorsa (ya da duraklatılmışsa) halkayı ve saati hemen doğru göster.
  if (running && view === "timer") updateRunningView(timer.remainingMs);
  // Bilgisayarda menü hep açık; hangi sayfadaysak o vurgulansın diye onu da yeniden çiz.
  if (isDesktop()) renderMenu();
}

/** Projeler tıklanabilir "chip" olarak; sonda yeni proje penceresini açan "+ Proje" butonu. */
function subjectPickerHtml(): string {
  const subjects = loadSubjects();
  // Seçili ders listeden silindiyse seçimi "Genel"e döndür.
  if (currentSubject && !subjects.includes(currentSubject)) currentSubject = undefined;

  const chip = (value: string, label: string) => {
    const selected = (currentSubject ?? "") === value;
    const dot = value
      ? `<i class="chip-dot" style="--c:${projectColor(value)}"></i>`
      : `<i class="chip-dot general"></i>`;
    return `<button class="chip ${selected ? "selected" : ""}" data-subject="${escapeHtml(value)}">${dot}${escapeHtml(label)}</button>`;
  };

  return `
    <div class="subject-picker setup-block">
      <div class="setup-head">
        <span class="setup-kicker">Proje</span>
        <span class="setup-title">Ne için çalışıyorsun?</span>
        <span class="setup-opt">isteğe bağlı</span>
      </div>
      <div class="chips">
        ${chip("", "Genel")}
        ${subjects.map((s) => chip(s, s)).join("")}
        <button id="new-project" class="chip add" title="Yeni proje ekle">＋ Yeni proje</button>
      </div>
    </div>`;
}

/** Proje adından sabit bir renk (her proje hep aynı renkte görünsün). */
function projectColor(name: string): string {
  const palette = ["#7dd3fc", "#818cf8", "#c084fc", "#f472b6", "#ff9a3c", "#ffd166", "#34d399", "#60a5fa"];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

// ---------- Süre seçimi ----------

const DURATION_PRESETS: { min: number; label: string }[] = [
  { min: 15, label: "Isınma" },
  { min: 25, label: "Klasik" },
  { min: 45, label: "Derin" },
  { min: 60, label: "Uzun" },
  { min: 90, label: "Maraton" },
];

/** Süre kutusu: büyük sayı, − / + düğmeleri, hazır süreler ve altta teşvik satırı. */
function durationHtml(): string {
  const presets = DURATION_PRESETS.map(
    (p) => `<button type="button" class="preset" data-min="${p.min}"><b>${p.min}</b><small>${p.label}</small></button>`,
  ).join("");
  return `
    <div class="setup-block">
      <div class="setup-head">
        <span class="setup-kicker">Süre</span>
        <span class="setup-title">Ne kadar odaklanacaksın?</span>
      </div>
      <div class="stepper">
        <button type="button" class="step" data-step="-5" aria-label="5 dakika azalt">−</button>
        <label class="stepper-value">
          <input id="minutes" type="number" min="1" max="600" inputmode="numeric"
                 value="${settings.defaultWorkMin}" aria-label="Süre (dakika)" />
          <span>dakika</span>
        </label>
        <button type="button" class="step" data-step="5" aria-label="5 dakika artır">+</button>
      </div>
      <div class="presets">${presets}</div>
      <p id="duration-hint" class="duration-hint"></p>
    </div>`;
}

/** Süreye göre: seçili hazır süre, bitiş saati, hedefe katkı, düğmedeki yazı. */
function updateDurationUi(): void {
  const input = document.querySelector<HTMLInputElement>("#minutes");
  if (!input) return;
  const min = Math.max(0, Math.round(Number(input.value) || 0));
  document
    .querySelectorAll<HTMLButtonElement>(".preset")
    .forEach((b) => b.classList.toggle("selected", Number(b.dataset.min) === min));

  const work = document.querySelector<HTMLButtonElement>("#work");
  if (work) work.textContent = min > 0 ? `Gazla · ${min} dk 🚀` : "Gazla 🚀";

  const hint = document.querySelector<HTMLElement>("#duration-hint");
  if (!hint) return;
  if (min <= 0) {
    hint.innerHTML = `<span class="muted">Bir süre seç, gerisi sende.</span>`;
    return;
  }
  const end = new Date(Date.now() + min * 60_000);
  const endText = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
  const { goal, done } = goalInfo("daily");
  let goalText = "";
  if (goal > 0) {
    if (done >= goal) goalText = "Günlük hedef zaten cepte, bu seans bonus 🔥";
    else if (done + min >= goal) goalText = "Bu seansla günlük hedefin tamam 🎯";
    else goalText = `Bitince günlük hedefin <b>%${Math.round(((done + min) / goal) * 100)}</b>'i dolacak`;
  }
  hint.innerHTML = `<span>⏰ <b>${endText}</b>'de bitiyor</span>${goalText ? `<span>${goalText}</span>` : ""}`;
}

function bindDuration(): void {
  const input = document.querySelector<HTMLInputElement>("#minutes");
  if (!input) {
    return;
  }
  input.addEventListener("input", updateDurationUi);
  document.querySelectorAll<HTMLButtonElement>(".step").forEach((b) =>
    b.addEventListener("click", () => {
      const cur = Number(input.value) || 0;
      const next = Math.min(600, Math.max(5, Math.round((cur + Number(b.dataset.step)) / 5) * 5));
      input.value = String(next);
      updateDurationUi();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>(".preset").forEach((b) =>
    b.addEventListener("click", () => {
      input.value = b.dataset.min!;
      updateDurationUi();
    }),
  );
  updateDurationUi();
}

/** Ders modunda seçici yerine: ders sabit, değiştirmek için menü. */
function lockedSubjectHtml(): string {
  return `
    <div class="locked-subject">
      <span class="muted">Proje</span>
      <strong>${escapeHtml(focusSubject!)}</strong>
      <span class="muted small-note">Değiştirmek için ☰ menü</span>
    </div>`;
}

/** Ders modunda en altta: bu dersin bugün / hafta / toplam süresi ve son 7 günü. */
function subjectStatsHtml(name: string): string {
  const row = statsBySubject().find((r) => r.subject === name);
  const today = row?.todayMin ?? 0;
  const week = row?.weekMin ?? 0;
  const total = row?.totalMin ?? 0;
  return `
    <section class="card totals">
      <div><span class="muted">Bugün</span><strong>${formatMinutes(today)}</strong></div>
      <div><span class="muted">Bu hafta</span><strong>${formatMinutes(week)}</strong></div>
      <div><span class="muted">Toplam</span><strong>${formatMinutes(total)}</strong></div>
    </section>
    <section class="card">
      <div class="card-title">${escapeHtml(name)} · son 7 gün <span class="muted">(dk)</span></div>
      ${daysChartHtml(lastSevenDays(name))}
    </section>`;
}

// ---------- "+ Proje" penceresi ----------
// Ortada açılan küçük pencere (modal): yeni projenin adını sorar.
// Eklenen proje hemen seçilir; menüde ve istatistiklerde de görünür.

const modalRoot = document.createElement("div");
document.body.append(modalRoot);

function openNewProjectModal(): void {
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <form class="modal card" id="new-project-form">
        <div class="card-title">Yeni proje</div>
        <input id="new-project-name" type="text" placeholder="Örn. Analysis I" maxlength="40" autocomplete="off" />
        <div class="row">
          <button type="button" class="secondary" id="new-project-cancel">Vazgeç</button>
          <button type="submit" class="primary">Ekle</button>
        </div>
      </form>
    </div>`;
  const input = modalRoot.querySelector<HTMLInputElement>("#new-project-name")!;
  input.focus();

  const close = () => (modalRoot.innerHTML = "");
  modalRoot.querySelector("#new-project-cancel")!.addEventListener("click", close);
  // Pencerenin dışına (karartılmış alana) tıklayınca kapansın; pencerenin içine tıklayınca değil.
  modalRoot.querySelector(".modal-backdrop")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // <form> olduğu için Enter'a basmak da "Ekle" gibi çalışır.
  modalRoot.querySelector("#new-project-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    if (!addSubject(name)) {
      toast(`"${name}" zaten listede.`);
      input.select();
      return;
    }
    runSync(); // giriş yapılmışsa hesaba da yükle
    close();
    currentSubject = name; // yeni proje hemen seçili olsun
    // render() ekranı baştan çizer; yazılmış süre kaybolmasın diye saklayıp geri koyuyoruz.
    const minutes = document.querySelector<HTMLInputElement>("#minutes")?.value;
    render();
    const minutesInput = document.querySelector<HTMLInputElement>("#minutes");
    if (minutesInput && minutes) minutesInput.value = minutes;
    updateDurationUi();
    toast(`${name} eklendi. Gazla!`);
  });
}

// ---------- Sol menü ----------
// Menü #app'in dışında, ayrı bir kutuda çiziliyor. Böylece render() ana ekranı baştan çizse bile
// menü kapanmıyor, menüyü açıp kapamak da ana ekranı (ve yazdığın süreyi) bozmuyor.

const menuRoot = document.createElement("div");
document.body.append(menuRoot);

// Bilgisayar görünümü: ekran en az 900 piksel genişse menü solda sabit durur (CSS'teki sınırla aynı).
// C++'taki gibi düşün: bu bir "if (genişlik >= 900)"; pencere boyutu değişince sonuç da değişir.
const desktopQuery = window.matchMedia("(min-width: 900px)");
const isDesktop = () => desktopQuery.matches;
desktopQuery.addEventListener("change", () => {
  menuOpen = false;
  renderMenu();
  render();
});

function renderMenu(): void {
  const docked = isDesktop();
  if (!menuOpen && !docked) {
    menuRoot.innerHTML = "";
    return;
  }
  // Seans sürerken ders değiştirmek kaydı karıştırır, o yüzden ders geçişleri kilitli.
  const running = phase === "work" || phase === "break";
  const lock = running ? "disabled" : "";
  const subjects = loadSubjects();

  const subjectItems = subjects.length
    ? subjects
        .map((name) => {
          const goal = subjectGoal(name);
          const week = weekWorkMinutes(name);
          const info = goal !== undefined
            ? `${formatMinutes(Math.floor(week))} / ${formatMinutes(goal)}${week >= goal ? " ✅" : ""}`
            : `${formatMinutes(Math.floor(week))} bu hafta`;
          const active = focusSubject === name && view === "timer";
          return `
            <button class="menu-item ${active ? "active" : ""}" data-subject="${escapeHtml(name)}" ${lock}>
              <span>${escapeHtml(name)}</span>
              <span class="muted small-note">${info}</span>
            </button>`;
        })
        .join("")
    : `<p class="muted small-note menu-empty">Henüz proje yok.</p>`;

  menuRoot.innerHTML = `
    ${docked ? "" : `<div class="menu-backdrop"></div>`}
    <nav class="menu ${docked ? "docked" : ""}">
      <div class="menu-head">
        <span class="menu-brand"><img class="logo-mark small" src="/logo.svg" alt="" /><span class="logo small-logo">Gazzla</span></span>
        <button class="icon big menu-close" title="Kapat">✕</button>
      </div>
      <button class="menu-item ${!focusSubject && view === "timer" ? "active" : ""}" data-go="home" ${lock}>🏠 Ana ekran</button>
      <div class="menu-section">Projeler</div>
      ${subjectItems}
      ${running ? `<p class="muted small-note menu-empty">Seans sürerken proje değiştirilemez.</p>` : ""}
      <div class="menu-section"></div>
      <button class="menu-item" data-go="subjects" ${lock}>📚 Projeleri yönet</button>
      <button class="menu-item ${view === "goals" ? "active" : ""}" data-go="goals">🎯 Hedefler</button>
      <button class="menu-item ${view === "stats" ? "active" : ""}" data-go="stats">📊 İstatistikler</button>
      <button class="menu-item ${view === "friends" ? "active" : ""}" data-go="friends">
        <span>👥 Arkadaşlar${friendsData?.incoming.length ? ` <span class="badge">${friendsData.incoming.length}</span>` : ""}</span>
        ${activeFriends.length ? `<span class="muted small-note">🟢 ${activeFriends.length} kişi şu an aktif</span>` : ""}
      </button>
      <button class="menu-item ${view === "account" ? "active" : ""}" data-go="account">
        <span>👤 Hesap</span>
        <span class="muted small-note">${authUser ? escapeHtml(authUser.email) : "Giriş yapılmadı"}</span>
      </button>
    </nav>`;

  const close = () => {
    menuOpen = false;
    renderMenu();
  };
  menuRoot.querySelector(".menu-backdrop")?.addEventListener("click", close);
  menuRoot.querySelector(".menu-close")?.addEventListener("click", close);

  menuRoot.querySelectorAll<HTMLButtonElement>(".menu-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      const go = btn.dataset.go;
      if (btn.dataset.subject !== undefined) {
        focusSubject = btn.dataset.subject;
        currentSubject = focusSubject;
        view = "timer";
      } else if (go === "home") {
        focusSubject = undefined;
        currentSubject = settings.lastSubject; // ana ekranda son seçilen ders geri gelsin
        view = "timer";
      } else if (go === "subjects") {
        view = "subjects";
      } else if (go === "stats") {
        view = "stats";
      } else if (go === "goals") {
        view = "goals";
        goalsEdit = undefined;
      } else if (go === "account") {
        view = "account";
      } else if (go === "friends") {
        view = "friends";
        refreshFriends();
      }
      editingGoal = undefined;
      close();
      render();
    }),
  );
}

// Esc ile menüyü kapat.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen) {
    menuOpen = false;
    renderMenu();
  }
});

// Boşluk tuşu: zamanlayıcı ekranında başlat / duraklat / devam et.
// Yazı kutusundaysan ya da bir düğme seçiliyse (boşluk zaten onu tıklar) karışmıyoruz.
document.addEventListener("keydown", (e) => {
  if (e.key !== " " || e.repeat || view !== "timer" || modalRoot.innerHTML) return;
  const target = e.target as HTMLElement;
  if (target.closest("input, textarea, select, button, [contenteditable]")) return;
  const btn = document.querySelector<HTMLButtonElement>("#pause, #resume, #work");
  if (!btn) return;
  e.preventDefault(); // sayfa aşağı kaymasın
  btn.click();
});

// ---------- Bulut eşitleme ----------

function syncStatusText(): string {
  if (syncState === "syncing") return "☁️ Eşitleniyor...";
  if (syncState === "error") return `⚠️ Eşitlenemedi: ${escapeHtml(syncError ?? "")}`;
  if (lastSyncAt) {
    const time = new Date(lastSyncAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    return `✅ Kayıtlar hesabında (son eşitleme ${time})`;
  }
  return "☁️ Henüz eşitlenmedi.";
}

/**
 * Giriş yapılmışsa kayıtları eşitler. Sonuç gelince gerekiyorsa ekranı yeniler.
 * showResult: "Şimdi eşitle"ye basıldıysa sonucu mesajla da göster.
 */
async function runSync(showResult = false): Promise<void> {
  if (!authUser) return;
  syncState = "syncing";
  if (view === "account") render();

  const result = await sync(authUser.id);
  syncState = result.ok ? "idle" : "error";
  syncError = result.error;
  if (result.ok) lastSyncAt = Date.now();
  if (showResult) toast(result.ok ? "Eşitlendi ✅" : `Eşitlenemedi: ${result.error}`);

  // Ekranı yenile: hesap ekranındaysa durum yazısı için, başka cihazdan yeni kayıt geldiyse
  // istatistikler için. Seans sürerken dokunmuyoruz; yazılmış süre de kaybolmasın.
  const running = phase === "work" || phase === "break";
  if (view === "account" || (result.changed && !running)) {
    const minutes = document.querySelector<HTMLInputElement>("#minutes")?.value;
    render();
    const input = document.querySelector<HTMLInputElement>("#minutes");
    if (input && minutes) input.value = minutes;
    updateDurationUi();
  }
}

// Uygulamaya geri dönünce (telefonda sekme değiştirince) ve internet geri gelince eşitle.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) runSync();
});
window.addEventListener("online", () => runSync());

// ---------- Arkadaşlar ----------

/** Kendi durumumu arkadaşlara gönder (giriş yapılmışsa). */
function publishPresence(): void {
  if (!authUser || !(phase === "work" || phase === "break")) return;
  setPresence(authUser.id, {
    kind: phase,
    startedAt: timer.startTime,
    endsAt: Date.now() + timer.remainingMs,
    paused: timer.paused,
  });
}

/** "@mehmet: 🟢 çalışıyor · 23 dk kaldı" gibi durum yazısı. */
function presenceText(p: Presence | null): string {
  if (!isActive(p)) return "";
  if (p.paused) return "⏸ duraklattı";
  if (p.kind === "break") return "☕ arada";
  const left = Math.max(1, Math.round((p.endsAt - Date.now()) / 60000));
  return `🟢 çalışıyor · ${left} dk kaldı`;
}

/** Zamanlayıcı ekranındaki "şu an seninle çalışıyor" satırı (önbellekteki listeden çizilir). */
function updateTogetherLine(): void {
  const el = document.querySelector("#together");
  if (!el) return;
  const now = Date.now();
  const list = activeFriends.filter((f) => isActive(f.presence, now));
  const working = list.filter((f) => f.presence.kind === "work").map((f) => `@${escapeHtml(f.username)}`);
  const resting = list.filter((f) => f.presence.kind === "break").map((f) => `@${escapeHtml(f.username)}`);
  const iAmWorking = phase === "work";

  const parts: string[] = [];
  if (working.length)
    parts.push(`🔥 ${iAmWorking ? "Şu an seninle çalışıyor" : "Şu an çalışıyor"}: ${working.join(", ")}${iAmWorking ? "" : " · sen de katıl!"}`);
  if (resting.length) parts.push(`☕ Arada: ${resting.join(", ")}`);
  el.innerHTML = parts.join("<br>");

  // Bilgisayardaki sağ sütun kartı: her arkadaş ayrı satırda, durumuyla.
  const side = document.querySelector("#side-friends");
  if (side) {
    side.innerHTML = list.length
      ? list
          .map((f) => `<li><span>@${escapeHtml(f.username)}</span><span class="muted small-note">${presenceText(f.presence)}</span></li>`)
          .join("")
      : `<li class="muted small-note">Şu an kimse çalışmıyor. İlk sen başla!</li>`;
  }
}

/** Aktif arkadaşları Supabase'den yeniden al. */
async function refreshTogether(): Promise<void> {
  if (!authUser) {
    activeFriends = [];
    return;
  }
  activeFriends = await loadActiveFriends(authUser.id);
  updateTogetherLine();
  if (isDesktop()) renderMenu(); // menüdeki "x kişi aktif" yazısı güncel kalsın
}

/** Arkadaşlar ekranının verilerini yeniden al; ekrandaysak yeniden çiz. */
async function refreshFriends(): Promise<void> {
  if (!authUser) return;
  try {
    if (myProfile === undefined) myProfile = await getMyProfile(authUser.id);
    if (myProfile) {
      friendsData = await loadFriendsOverview(authUser.id);
      activeFriends = friendsData.friends
        .filter((f) => isActive(f.presence))
        .map((f) => ({ id: f.id, username: f.username, presence: f.presence! }));
    }
    friendsError = undefined;
  } catch (e) {
    friendsError = (e as Error).message;
  }
  if (view === "friends") rerenderKeeping("#friend-name", "#username-input");
  else if (isDesktop()) renderMenu(); // menüdeki istek rozeti güncel kalsın
}

/** Ekranı yeniden çizer ama verilen kutulara yazılmış metni korur. */
function rerenderKeeping(...selectors: string[]): void {
  const saved = selectors.map((sel) => document.querySelector<HTMLInputElement>(sel)?.value);
  const focused = document.activeElement?.id;
  render();
  selectors.forEach((sel, i) => {
    const input = document.querySelector<HTMLInputElement>(sel);
    if (input && saved[i]) input.value = saved[i]!;
  });
  if (focused) document.getElementById(focused)?.focus();
}

function renderFriends(): void {
  const back = `<button id="back" class="back">← Zamanlayıcıya dön</button>`;
  let body: string;

  if (!authUser) {
    body = `
      <section class="card account">
        <div class="card-title">Arkadaşlar</div>
        <p class="muted">Arkadaşlarınla birbirinizi gazlamak için önce giriş yap.</p>
        <button id="go-account" class="primary">👤 Giriş yap</button>
      </section>`;
  } else if (myProfile === undefined) {
    body = `<section class="card"><p class="muted">Yükleniyor...</p></section>`;
  } else if (myProfile === null) {
    body = `
      <section class="card account">
        <div class="card-title">Kullanıcı adını seç</div>
        <p class="muted small-note">Arkadaşların seni bu adla bulacak. Küçük harf, rakam ve _ (3-20 karakter).</p>
        <form id="username-form" class="inline-form">
          <input id="username-input" type="text" placeholder="örn. ahmet_k" maxlength="20" autocomplete="off" />
          <button class="small primary" type="submit">Kaydet</button>
        </form>
        ${friendsError ? `<p class="sync-status error">${escapeHtml(friendsError)}</p>` : ""}
      </section>`;
  } else {
    const data = friendsData;
    const incoming = data?.incoming ?? [];
    const outgoing = data?.outgoing ?? [];

    // Sıralama: sen + arkadaşlar, bu haftaki süreye göre.
    const me = {
      id: authUser.id,
      username: myProfile.username,
      todayMin: todayWorkMinutes(),
      weekMin: weekWorkMinutes(),
      status:
        phase === "work" || phase === "break"
          ? timer.paused ? "⏸ duraklattın" : phase === "work" ? "🟢 çalışıyorsun" : "☕ aradasın"
          : "",
      isMe: true,
    };
    const people = [
      me,
      ...(data?.friends ?? []).map((f) => ({ ...f, status: presenceText(f.presence), isMe: false })),
    ].sort((a, b) => b.weekMin - a.weekMin);

    const board = people
      .map((p, i) => {
        const medal = ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
        const removing = confirmRemoveFriend === p.id;
        return `
          <li class="friend-row ${p.isMe ? "me" : ""}">
            <span class="rank">${medal}</span>
            <div class="friend-info">
              <span class="friend-name">@${escapeHtml(p.username)}${p.isMe ? ` <span class="muted">(sen)</span>` : ""}</span>
              <span class="muted small-note">${p.status || "&nbsp;"}</span>
            </div>
            <div class="friend-times">
              <span><span class="muted small-note">bugün</span> ${formatMinutes(p.todayMin)}</span>
              <strong>${formatMinutes(p.weekMin)}</strong>
            </div>
            ${
              p.isMe
                ? `<span class="remove-spacer"></span>`
                : `<button class="small ${removing ? "danger" : "ghost"} remove-friend" data-id="${p.id}"
                     title="Arkadaşlıktan çıkar">${removing ? "Emin misin?" : "✕"}</button>`
            }
          </li>`;
      })
      .join("");

    const requestRow = (p: Profile, kind: "in" | "out") => `
      <li class="request-row">
        <span>@${escapeHtml(p.username)}</span>
        <span class="request-actions">
          ${
            kind === "in"
              ? `<button class="small primary accept" data-id="${p.id}">Kabul et</button>
                 <button class="small ghost reject" data-id="${p.id}">Reddet</button>`
              : `<span class="muted small-note">bekliyor</span>
                 <button class="small ghost reject" data-id="${p.id}">İptal</button>`
          }
        </span>
      </li>`;

    body = `
      ${
        incoming.length
          ? `<section class="card">
               <div class="card-title">Gelen istekler</div>
               <ul class="request-list">${incoming.map((p) => requestRow(p, "in")).join("")}</ul>
             </section>`
          : ""
      }
      <section class="card">
        <div class="card-title">Bu hafta <span class="muted">(proje adları gizli, sadece süreler)</span></div>
        ${data ? `<ul class="friend-list">${board}</ul>` : `<p class="muted">Yükleniyor...</p>`}
        ${data && data.friends.length === 0 ? `<p class="muted small-note">Henüz arkadaşın yok. Aşağıdan kullanıcı adıyla ekle!</p>` : ""}
        ${friendsError ? `<p class="sync-status error">${escapeHtml(friendsError)}</p>` : ""}
      </section>
      <section class="card">
        <div class="card-title">Arkadaş ekle</div>
        <form id="add-friend-form" class="inline-form">
          <input id="friend-name" type="text" placeholder="kullanıcı adı" maxlength="21" autocomplete="off" />
          <button class="small primary" type="submit">Ekle</button>
        </form>
        ${outgoing.length ? `<ul class="request-list">${outgoing.map((p) => requestRow(p, "out")).join("")}</ul>` : ""}
        <p class="muted small-note">Senin kullanıcı adın: <strong>@${escapeHtml(myProfile.username)}</strong> · arkadaşlarına bunu söyle.</p>
      </section>`;
  }

  app.innerHTML = `${headerHtml()}${back}${body}`;

  document.querySelector("#back")!.addEventListener("click", () => {
    view = "timer";
    confirmRemoveFriend = undefined;
    render();
    refreshTogether();
  });
  document.querySelector("#go-account")?.addEventListener("click", () => {
    view = "account";
    render();
  });

  document.querySelector("#username-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLInputElement>("#username-input")!;
    const error = await saveUsername(authUser!.id, input.value);
    if (error) {
      friendsError = error;
      rerenderKeeping("#username-input");
      return;
    }
    friendsError = undefined;
    myProfile = undefined; // yeniden yükle
    toast("Kullanıcı adın kaydedildi! 🎉");
    refreshFriends();
  });

  document.querySelector("#add-friend-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLInputElement>("#friend-name")!;
    const { ok, message } = await sendFriendRequest(authUser!.id, input.value);
    toast(message);
    if (ok) {
      input.value = "";
      refreshFriends();
    }
  });

  document.querySelectorAll<HTMLButtonElement>(".accept").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const error = await acceptRequest(btn.dataset.id!, authUser!.id);
      toast(error ?? "Artık arkadaşsınız! Birbirinizi gazlayın 🔥");
      refreshFriends();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>(".reject").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const error = await removeFriendship(btn.dataset.id!, authUser!.id);
      if (error) toast(error);
      refreshFriends();
    }),
  );
  // Çıkarma iki adımlı: ilk basışta "Emin misin?", ikincide çıkarır.
  document.querySelectorAll<HTMLButtonElement>(".remove-friend").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id!;
      if (confirmRemoveFriend !== id) {
        confirmRemoveFriend = id;
        rerenderKeeping("#friend-name");
        return;
      }
      confirmRemoveFriend = undefined;
      const error = await removeFriendship(id, authUser!.id);
      toast(error ?? "Arkadaşlıktan çıkarıldı.");
      refreshFriends();
    }),
  );
}

// Her 30 saniyede bir: arkadaşlar ekranındaysan listeyi, zamanlayıcıdaysan "kim çalışıyor"u yenile.
// Sekme arka plandaysa boşuna istek atma.
window.setInterval(() => {
  if (document.hidden || !authUser) return;
  if (view === "friends") refreshFriends();
  else if (view === "timer") refreshTogether();
}, 30_000);

// ---------- Hesap ekranı ----------

function renderAccount(): void {
  const back = `<button id="back" class="back">← Zamanlayıcıya dön</button>`;

  if (authUser) {
    app.innerHTML = `
      ${headerHtml()}
      ${back}
      <section class="card account">
        <div class="card-title">Hesap</div>
        <p>Giriş yapıldı: <strong>${escapeHtml(authUser.email)}</strong></p>
        <p class="sync-status ${syncState}">${syncStatusText()}</p>
        <button id="sync-now" class="small ghost" ${syncState === "syncing" ? "disabled" : ""}>☁️ Şimdi eşitle</button>
        <p class="muted small-note">Çalışma kayıtların, proje listen ve hedeflerin bu hesaba yükleniyor;
          aynı hesapla telefondan girince orada da görünür. Proje adlarını arkadaşların göremez.</p>
        <button id="sign-out" class="secondary" ${authBusy ? "disabled" : ""}>Çıkış yap</button>
      </section>`;
    document.querySelector("#sync-now")!.addEventListener("click", () => runSync(true));
    document.querySelector("#sign-out")!.addEventListener("click", async () => {
      authBusy = true;
      render();
      await signOut();
      authBusy = false;
      toast("Çıkış yapıldı.");
      render();
    });
  } else {
    const signup = authMode === "signup";
    app.innerHTML = `
      ${headerHtml()}
      ${back}
      <section class="card account">
        <div class="card-title">${signup ? "Hesap oluştur" : "Giriş yap"}</div>
        <p class="muted small-note">Giriş zorunlu değil; arkadaşlarınla ilerlemeyi paylaşmak için gerekecek.</p>
        <form id="auth-form" class="auth-form">
          <label>E-posta
            <input id="auth-email" type="email" autocomplete="email" required />
          </label>
          <label>Şifre ${signup ? `<span class="muted small-note">(en az 6 karakter)</span>` : ""}
            <input id="auth-password" type="password" minlength="6" required
              autocomplete="${signup ? "new-password" : "current-password"}" />
          </label>
          <button type="submit" class="primary" ${authBusy ? "disabled" : ""}>
            ${authBusy ? "Bekle..." : signup ? "Kayıt ol" : "Giriş yap"}
          </button>
        </form>
        <button id="auth-switch" class="small ghost">
          ${signup ? "Zaten hesabın var mı? Giriş yap" : "Hesabın yok mu? Kayıt ol"}
        </button>
      </section>`;

    document.querySelector("#auth-switch")!.addEventListener("click", () => {
      authMode = signup ? "signin" : "signup";
      render();
    });

    document.querySelector("#auth-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.querySelector<HTMLInputElement>("#auth-email")!.value.trim();
      const password = document.querySelector<HTMLInputElement>("#auth-password")!.value;

      // Butonu kilitle ama ekranı baştan çizme (yoksa yazdıkların silinir).
      authBusy = true;
      const submit = document.querySelector<HTMLButtonElement>("#auth-form button[type=submit]")!;
      submit.disabled = true;
      submit.textContent = "Bekle...";

      // await: C++'taki future.get() gibi, cevap gelene kadar bu fonksiyon burada bekler
      // (ama ekran donmaz, tarayıcı başka işlere devam eder).
      if (signup) {
        const { error, needsConfirm } = await signUp(email, password);
        authBusy = false;
        if (error) {
          toast(error);
        } else if (needsConfirm) {
          toast("Hesap oluşturuldu! E-postana gelen onay linkine tıkla, sonra giriş yap.");
          authMode = "signin";
        } else {
          toast("Hesap oluşturuldu, hoş geldin! 🚀");
        }
      } else {
        const error = await signIn(email, password);
        authBusy = false;
        if (error) toast(error);
        else toast("Giriş yapıldı. Gazla! 🚀");
      }
      render();
      // Hata olduysa e-posta kutusu boş kalmasın.
      const emailInput = document.querySelector<HTMLInputElement>("#auth-email");
      if (emailInput && !authUser) emailInput.value = email;
    });
  }

  document.querySelector("#back")!.addEventListener("click", () => {
    view = "timer";
    render();
  });
}

// ---------- Dersler ekranı ----------

function renderSubjects(): void {
  const subjects = loadSubjects();
  const totals = new Map(statsBySubject().map((r) => [r.subject, r.totalMin]));

  const rows = subjects.length
    ? subjects
        .map((name) => {
          const safe = escapeHtml(name);
          if (editingSubject === name) {
            return `
              <li class="subject-row">
                <form class="rename-form inline-form" data-subject="${safe}">
                  <input name="name" type="text" value="${safe}" maxlength="40" />
                  <button class="small primary" type="submit">Kaydet</button>
                  <button class="small cancel" type="button">Vazgeç</button>
                </form>
              </li>`;
          }
          const deleting = confirmDelete === name;
          return `
            <li class="subject-row">
              <div class="subject-info">
                <span class="subject-name">${safe}</span>
                <span class="muted">${formatMinutes(totals.get(name) ?? 0)} toplam</span>
              </div>
              <div class="subject-actions">
                <button class="icon rename" data-subject="${safe}" title="Adını değiştir">✎</button>
                <button class="small ${deleting ? "danger" : "ghost"} delete" data-subject="${safe}">
                  ${deleting ? "Emin misin?" : "Sil"}
                </button>
              </div>
            </li>`;
        })
        .join("")
    : `<li class="muted empty">Henüz proje yok. Yukarıdan ilkini ekle.</li>`;

  app.innerHTML = `
    ${headerHtml()}
    <button id="back" class="back">← Zamanlayıcıya dön</button>
    <section class="card">
      <div class="card-title">Yeni proje</div>
      <form id="add-form" class="inline-form">
        <input id="add-name" type="text" placeholder="Örn. Analysis I" maxlength="40" />
        <button class="small primary" type="submit">Ekle</button>
      </form>
    </section>
    <section class="card">
      <div class="card-title">Projelerin</div>
      <ul class="subject-list">${rows}</ul>
      <p class="hint muted">Bir projeyi silmek geçmiş kayıtlarını silmez; istatistiklerde görünmeye devam eder.</p>
    </section>`;

  document.querySelector("#back")!.addEventListener("click", () => {
    view = "timer";
    editingSubject = confirmDelete = undefined;
    render();
  });

  // Ekle (Enter'a basmak da çalışır, çünkü bu bir <form>).
  document.querySelector("#add-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.querySelector<HTMLInputElement>("#add-name")!.value.trim();
    if (!name) return;
    if (!addSubject(name)) {
      toast(`"${name}" zaten listede.`);
      return;
    }
    runSync(); // giriş yapılmışsa hesaba da yükle
    toast(`${name} eklendi.`);
    render();
    document.querySelector<HTMLInputElement>("#add-name")?.focus();
  });

  document.querySelectorAll<HTMLButtonElement>(".rename").forEach((btn) =>
    btn.addEventListener("click", () => {
      editingSubject = btn.dataset.subject;
      confirmDelete = undefined;
      render();
      document.querySelector<HTMLInputElement>(".rename-form input")?.select();
    }),
  );

  document.querySelector(".rename-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const oldName = form.dataset.subject!;
    const newName = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    if (newName && newName !== oldName) {
      if (!renameSubject(oldName, newName)) {
        toast(`"${newName}" zaten listede.`);
        return;
      }
      runSync();
      if (currentSubject === oldName) currentSubject = newName;
      if (focusSubject === oldName) focusSubject = newName;
      if (settings.lastSubject === oldName) {
        settings.lastSubject = newName;
        saveSettings(settings);
      }
    }
    editingSubject = undefined;
    render();
  });

  document.querySelector(".rename-form .cancel")?.addEventListener("click", () => {
    editingSubject = undefined;
    render();
  });

  // Silme iki adımlı: ilk basışta "Emin misin?", ikincide siler.
  document.querySelectorAll<HTMLButtonElement>(".delete").forEach((btn) =>
    btn.addEventListener("click", () => {
      const name = btn.dataset.subject!;
      if (confirmDelete !== name) {
        confirmDelete = name;
        render();
        return;
      }
      removeSubject(name);
      runSync();
      if (currentSubject === name) currentSubject = undefined;
      if (focusSubject === name) focusSubject = undefined;
      if (settings.lastSubject === name) {
        settings.lastSubject = undefined;
        saveSettings(settings);
      }
      confirmDelete = undefined;
      toast(`${name} silindi.`);
      render();
    }),
  );
}

function formatMinutes(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} dk`;
  return m === 0 ? `${h} sa` : `${h} sa ${m} dk`;
}

/**
 * 7 günlük sütun grafiği. goalMin verilirse kesikli "hedef" çizgisi çizilir
 * ve hedefi geçen günler yeşil olur (ders grafiğinde günlük hedef yok, verilmiyor).
 */
function daysChartHtml(days: { label: string; minutes: number }[], goalMin?: number): string {
  const maxDay = Math.max(goalMin ?? 1, ...days.map((d) => d.minutes), 1);
  const cols = days
    .map((d) => {
      const p = d.minutes / maxDay;
      const met = goalMin !== undefined && d.minutes >= goalMin;
      const today = d.label === "Bugün";
      return `
        <div class="col ${met ? "met" : ""} ${today ? "today" : ""}">
          <span class="col-val">${d.minutes > 0 ? Math.round(d.minutes) : ""}</span>
          <div class="col-bar" style="height:calc((100% - 20px) * ${p.toFixed(4)})"></div>
        </div>`;
    })
    .join("");
  const labels = days
    .map((d) => `<span class="${d.label === "Bugün" ? "today" : ""}">${d.label}</span>`)
    .join("");
  const goalLine =
    goalMin !== undefined
      ? `<div class="chart-goal" style="bottom:calc((100% - 20px) * ${(goalMin / maxDay).toFixed(4)})"><span>hedef ${formatMinutes(goalMin)}</span></div>`
      : "";
  return `
    <div class="chart">
      <div class="chart-cols">${goalLine}${cols}</div>
      <div class="chart-labels">${labels}</div>
    </div>`;
}

/** Sayfa başlığı: küçük üst yazı, büyük başlık, altında açıklama. */
function pageHeadHtml(kicker: string, title: string, sub = ""): string {
  return `
    <section class="page-head">
      <span class="setup-kicker">${kicker}</span>
      <h2>${title}</h2>
      ${sub ? `<p>${sub}</p>` : ""}
    </section>`;
}

function renderStats(): void {
  const rows = statsBySubject();
  const days = lastSevenDays();
  const weekTotal = rows.reduce((sum, r) => sum + r.weekMin, 0);
  const weekPct = settings.weeklyGoalMin > 0 ? Math.round((weekTotal / settings.weeklyGoalMin) * 100) : 0;
  const allTotal = rows.reduce((sum, r) => sum + r.totalMin, 0);
  const today = todayWorkMinutes();
  const streak = currentStreak(settings.dailyGoalMin);
  const sevenTotal = days.reduce((sum, d) => sum + d.minutes, 0);
  const avg = Math.round(sevenTotal / 7);
  const best = days.reduce((a, d) => (d.minutes > a.minutes ? d : a), days[0]);
  const maxWeek = Math.max(1, ...rows.map((r) => r.weekMin));

  const sub =
    weekTotal > 0
      ? `Haftalık hedefinin <b>%${weekPct}</b>'i tamam${weekPct >= 100 ? " — helal! 🎉" : ". Devam!"}`
      : "Bu hafta henüz seans yok. İlk seansla grafiği doldur!";

  const projectRows = rows.length
    ? rows
        .map(
          (r) => `
        <li class="prow">
          <i class="chip-dot" style="--c:${r.subject === GENERAL ? "#94a0b8" : projectColor(r.subject)}"></i>
          <div class="prow-main">
            <div class="prow-top">
              <span class="prow-name">${escapeHtml(r.subject)}</span>
              <strong>${formatMinutes(r.weekMin)}</strong>
            </div>
            <div class="bar thin"><div class="fill" style="width:${(r.weekMin / maxWeek) * 100}%;background:${r.subject === GENERAL ? "#94a0b8" : projectColor(r.subject)}"></div></div>
            <div class="prow-sub">bugün ${formatMinutes(r.todayMin)} · toplam ${formatMinutes(r.totalMin)}</div>
          </div>
        </li>`,
        )
        .join("")
    : `<li class="empty muted">Henüz kayıt yok. İlk seansı başlat!</li>`;

  app.innerHTML = `
    ${headerHtml()}
    ${pageHeadHtml("İstatistikler", `Bu hafta <span class="grad-text">${formatMinutes(weekTotal)}</span>`, sub)}
    <section class="kpis">
      <div class="kpi"><span>Bugün</span><strong>${formatMinutes(today)}</strong>
        <small>${settings.dailyGoalMin > 0 ? `hedef ${formatMinutes(settings.dailyGoalMin)}` : ""}</small></div>
      <div class="kpi"><span>Bu hafta</span><strong>${formatMinutes(weekTotal)}</strong>
        <div class="bar thin"><div class="fill" style="width:${Math.min(100, weekPct)}%"></div></div></div>
      <div class="kpi"><span>Seri</span><strong>${streak} gün</strong>
        <small>${streak > 0 ? "🔥 bozma!" : "bugün başlat"}</small></div>
      <div class="kpi"><span>Toplam</span><strong>${formatMinutes(allTotal)}</strong>
        <small>${weekPauseCount()} duraklatma bu hafta</small></div>
    </section>
    <section class="card">
      <div class="card-head">
        <div class="card-title">Son 7 gün</div>
        <span class="muted card-meta">ort. ${formatMinutes(avg)}/gün${best && best.minutes > 0 ? ` · en iyi: ${best.label}` : ""}</span>
      </div>
      ${daysChartHtml(days, settings.dailyGoalMin)}
    </section>
    <section class="card">
      <div class="card-head">
        <div class="card-title">Projelere göre</div>
        <span class="muted card-meta">bu hafta</span>
      </div>
      <ul class="prows">${projectRows}</ul>
    </section>`;
}

// ---------- Hedefler sayfası ----------

/** Küçük dairesel ilerleme göstergesi (yüzde ortada). */
function miniRingHtml(pct: number, met: boolean): string {
  const c = 2 * Math.PI * 42;
  const off = c * (1 - Math.min(1, pct / 100));
  return `
    <div class="mini-ring ${met ? "met" : ""}">
      <svg viewBox="0 0 100 100">
        <defs>
          <linearGradient id="grad-mini" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#7dd3fc" /><stop offset="50%" stop-color="#6366f1" /><stop offset="100%" stop-color="#ff7a18" />
          </linearGradient>
          <linearGradient id="grad-mini-met" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#10b981" /><stop offset="100%" stop-color="#60a5fa" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r="42" class="mr-track" />
        <circle cx="50" cy="50" r="42" class="mr-bar" stroke-dasharray="${c}" stroke-dashoffset="${off}" />
      </svg>
      <span>${met ? "✓" : `%${Math.round(pct)}`}</span>
    </div>`;
}

/** Hedef düzenleme kutusu. unit: "dk" ya da "sa" (haftalık hedefler saat olarak yazılır). */
function goalEditorHtml(key: string, currentMin: number, unit: "dk" | "sa", presets: number[], canRemove: boolean): string {
  const value = unit === "sa" ? Math.round((currentMin / 60) * 10) / 10 : currentMin;
  return `
    <div class="goal-editor" data-key="${escapeHtml(key)}">
      <div class="stepper small">
        <label class="stepper-value">
          <input id="goals-input" type="number" min="0.5" step="${unit === "sa" ? "0.5" : "5"}" inputmode="decimal" value="${value || ""}" />
          <span>${unit === "sa" ? "saat" : "dakika"}</span>
        </label>
      </div>
      <div class="presets">
        ${presets
          .map((v) => `<button type="button" class="preset ${v === value ? "selected" : ""}" data-v="${v}"><b>${v}</b><small>${unit}</small></button>`)
          .join("")}
      </div>
      <div class="row">
        ${canRemove ? `<button class="small ghost danger-text" id="goals-remove">Hedefi kaldır</button>` : ""}
        <button class="small ghost" id="goals-cancel">Vazgeç</button>
        <button class="small primary" id="goals-save" data-unit="${unit}">Kaydet</button>
      </div>
    </div>`;
}

function remainingText(done: number, goal: number, met: boolean): string {
  if (goal <= 0) return "";
  if (met) return `Hedef tamam, <b>+${formatMinutes(done - goal)}</b> bonus`;
  return `Hedefe <b>${formatMinutes(goal - done)}</b> kaldı`;
}

function renderGoals(): void {
  const daily = goalInfo("daily");
  const weekly = goalInfo("weekly");
  const dailyMet = daily.goal > 0 && daily.done >= daily.goal;
  const weeklyMet = weekly.goal > 0 && weekly.done >= weekly.goal;
  const dailyPct = daily.goal > 0 ? (daily.done / daily.goal) * 100 : 0;
  const weeklyPct = weekly.goal > 0 ? (weekly.done / weekly.goal) * 100 : 0;
  const streak = currentStreak(settings.dailyGoalMin);

  // Haftanın kalan günleri (bugün dahil; hafta pazartesi başlar).
  const daysLeft = 7 - ((new Date().getDay() + 6) % 7);
  const perDay = Math.ceil(Math.max(0, weekly.goal - weekly.done) / daysLeft);

  let sub: string;
  if (dailyMet && weeklyMet) sub = "Bugünün ve haftanın hedefi cepte. Gerisi bonus! 🏆";
  else if (dailyMet) sub = "Bugünkü hedef tamam 🎯 Haftalık hedef için böyle devam.";
  else if (daily.done > 0) sub = `İyi gidiyorsun! Bugün için <b>${formatMinutes(daily.goal - daily.done)}</b> daha.`;
  else sub = "Bugün henüz başlamadın. Bir seans, ve çubuklar dolmaya başlar.";

  const tile = (kind: "daily" | "weekly") => {
    const info = kind === "daily" ? daily : weekly;
    const met = kind === "daily" ? dailyMet : weeklyMet;
    const pct = kind === "daily" ? dailyPct : weeklyPct;
    const editing = goalsEdit === kind;
    return `
      <article class="goal-tile ${met ? "met" : ""}">
        <div class="goal-tile-main">
          ${miniRingHtml(pct, met)}
          <div class="goal-tile-body">
            <span class="setup-kicker">${kind === "daily" ? "Bugün" : "Bu hafta"} · hedef ${formatMinutes(info.goal)}</span>
            <div class="goal-tile-nums"><strong>${formatMinutes(info.done)}</strong></div>
            <span class="goal-tile-left">${remainingText(info.done, info.goal, met)}</span>
          </div>
          ${editing ? "" : `<button class="icon goal-tile-edit" data-gedit="${kind}" title="Hedefi değiştir">✎</button>`}
        </div>
        ${
          editing
            ? kind === "daily"
              ? goalEditorHtml("daily", info.goal, "dk", [60, 120, 180, 240, 300], false)
              : goalEditorHtml("weekly", info.goal, "sa", [5, 10, 15, 20, 30], false)
            : ""
        }
      </article>`;
  };

  const subjects = loadSubjects();
  const projectItems = subjects.length
    ? subjects
        .map((name) => {
          const goal = subjectGoal(name);
          const done = weekWorkMinutes(name);
          const key = `p:${name}`;
          const editing = goalsEdit === key;
          const met = goal !== undefined && done >= goal;
          const pct = goal ? Math.min(100, (done / goal) * 100) : 0;
          return `
          <li class="pgoal ${met ? "met" : ""}">
            <div class="pgoal-row">
              <i class="chip-dot" style="--c:${projectColor(name)}"></i>
              <div class="prow-main">
                <div class="prow-top">
                  <span class="prow-name">${escapeHtml(name)} ${met ? "✅" : ""}</span>
                  <span class="pgoal-nums">${goal !== undefined ? `<b>${formatMinutes(done)}</b> / ${formatMinutes(goal)}` : `<span class="muted">${done > 0 ? `${formatMinutes(done)} · ` : ""}hedef yok</span>`}</span>
                </div>
                ${goal !== undefined ? `<div class="bar thin"><div class="fill" style="width:${pct}%"></div></div>` : ""}
              </div>
              ${
                editing
                  ? ""
                  : goal !== undefined
                    ? `<button class="icon" data-gedit="${escapeHtml(key)}" title="Hedefi değiştir">✎</button>`
                    : `<button class="small ghost" data-gedit="${escapeHtml(key)}">+ Hedef</button>`
              }
            </div>
            ${editing ? goalEditorHtml(key, goal ?? 300, "sa", [2, 4, 6, 8, 10], goal !== undefined) : ""}
          </li>`;
        })
        .join("")
    : `<li class="empty muted">Henüz proje yok. Ana ekranda "＋ Yeni proje" ile ekleyebilirsin.</li>`;

  app.innerHTML = `
    ${headerHtml()}
    ${pageHeadHtml("Hedefler", dailyMet ? `Bugün <span class="grad-text">kazandın.</span>` : `Hedefine <span class="grad-text">%${Math.round(dailyPct)}</span> yakınsın.`, sub)}
    <section class="goal-tiles">
      ${tile("daily")}
      ${tile("weekly")}
    </section>
    <section class="insights">
      <div class="insight"><span>🔥</span><div><b>${streak} gün</b><small>üst üste günlük hedef</small></div></div>
      <div class="insight"><span>📅</span><div><b>${weeklyMet ? "Tamam!" : `${formatMinutes(perDay)}/gün`}</b><small>${weeklyMet ? "haftalık hedef cepte" : `kalan ${daysLeft} günde haftalık hedef için`}</small></div></div>
    </section>
    <section class="card">
      <div class="card-head">
        <div class="card-title">Proje hedefleri</div>
        <span class="muted card-meta">haftalık · isteğe bağlı</span>
      </div>
      <ul class="prows">${projectItems}</ul>
    </section>
    <button class="primary" id="goals-start">Hedefe gazla 🚀</button>`;

  document.querySelectorAll<HTMLButtonElement>("[data-gedit]").forEach((b) =>
    b.addEventListener("click", () => {
      goalsEdit = b.dataset.gedit;
      render();
      const input = document.querySelector<HTMLInputElement>("#goals-input");
      input?.focus();
      input?.select();
    }),
  );
  document.querySelector("#goals-start")?.addEventListener("click", () => {
    view = "timer";
    goalsEdit = undefined;
    render();
  });

  const editor = document.querySelector<HTMLElement>(".goal-editor");
  if (!editor) return;
  const key = editor.dataset.key!;
  const input = editor.querySelector<HTMLInputElement>("#goals-input")!;
  const syncPresets = () =>
    editor
      .querySelectorAll<HTMLButtonElement>(".preset")
      .forEach((p) => p.classList.toggle("selected", Number(p.dataset.v) === Number(input.value)));
  input.addEventListener("input", syncPresets);
  editor.querySelectorAll<HTMLButtonElement>(".preset").forEach((p) =>
    p.addEventListener("click", () => {
      input.value = p.dataset.v!;
      syncPresets();
    }),
  );
  const close = () => {
    goalsEdit = undefined;
    render();
  };
  editor.querySelector("#goals-cancel")?.addEventListener("click", close);
  editor.querySelector("#goals-remove")?.addEventListener("click", () => {
    const name = key.slice(2);
    setSubjectGoal(name, undefined);
    runSync();
    toast(`${name} için hedef kaldırıldı.`);
    close();
  });
  const save = () => {
    const unit = editor.querySelector<HTMLButtonElement>("#goals-save")!.dataset.unit;
    const raw = Number(input.value);
    const minutes = Math.round(unit === "sa" ? raw * 60 : raw);
    if (!minutes || minutes <= 0) {
      toast("Hedef en az 1 dakika olmalı.");
      return;
    }
    if (key === "daily") {
      settings.dailyGoalMin = minutes;
      saveSettings(settings);
      toast(`Yeni günlük hedef: ${formatMinutes(minutes)}. Gazla!`);
    } else if (key === "weekly") {
      settings.weeklyGoalMin = minutes;
      saveSettings(settings);
      toast(`Yeni haftalık hedef: ${formatMinutes(minutes)}. Gazla!`);
    } else {
      const name = key.slice(2);
      setSubjectGoal(name, minutes);
      runSync();
      toast(`${name} için haftalık hedef: ${formatMinutes(minutes)}. Gazla!`);
    }
    close();
  };
  editor.querySelector("#goals-save")?.addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") close();
  });
}

function bindGoalEditing(): void {
  document.querySelectorAll("[data-open-goals]").forEach((b) =>
    b.addEventListener("click", () => {
      view = "goals";
      goalsEdit = undefined;
      editingGoal = undefined;
      render();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>(".goal-edit-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      editingGoal = btn.dataset.goal as GoalKind;
      render();
      document.querySelector<HTMLInputElement>("#goal-input")?.focus();
    }),
  );

  const save = () => {
    const value = Math.round(Number(document.querySelector<HTMLInputElement>("#goal-input")!.value));
    if (!value || value <= 0) {
      toast("Hedef en az 1 dakika olmalı.");
      return;
    }
    if (editingGoal === "subject") {
      setSubjectGoal(focusSubject!, value);
      runSync();
      editingGoal = undefined;
      toast(`${focusSubject} için haftalık hedef: ${formatMinutes(value)}. Gazla!`);
      render();
      return;
    }
    if (editingGoal === "weekly") {
      settings.weeklyGoalMin = value;
      toast(`Yeni haftalık hedef: ${formatMinutes(value)}. Gazla!`);
    } else {
      settings.dailyGoalMin = value;
      toast(`Yeni günlük hedef: ${value} dk. Gazla!`);
    }
    saveSettings(settings);
    editingGoal = undefined;
    render();
  };
  document.querySelector("#goal-save")?.addEventListener("click", save);
  document.querySelector("#goal-remove")?.addEventListener("click", () => {
    setSubjectGoal(focusSubject!, undefined);
    runSync();
    editingGoal = undefined;
    toast(`${focusSubject} için hedef kaldırıldı.`);
    render();
  });
  // Kutudayken Enter'a basmak da kaydetsin.
  document.querySelector<HTMLInputElement>("#goal-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
}

// İlk açılışta bildirim izni iste (reddedilirse sadece ekrandaki mesaj ve ses kalır).
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

render();
initLanding();

// Açılışta daha önce giriş yapılmış mı bak; sonra giriş/çıkış olunca haberdar ol.
// Kullanıcı değişmediyse (Supabase arada oturumu sessizce yeniler) ekranı boşuna yeniden çizme.
// Giriş yapılınca (ya da açılışta zaten giriş yapılmışsa) kayıtları eşitle.
getCurrentUser().then((user) => {
  authUser = user;
  if (view === "account") render();
  runSync();
  refreshFriends(); // istek sayısı menüde, kullanıcı adı hazır olsun
  refreshTogether();
});
onAuthChange((user) => {
  const changed = user?.id !== authUser?.id;
  authUser = user;
  if (!changed) return;
  if (!user) {
    syncState = "idle";
    lastSyncAt = undefined;
  }
  // Hesap değişti: arkadaş bilgilerini sıfırla, yeniden yükle.
  myProfile = undefined;
  friendsData = undefined;
  activeFriends = [];
  if (view === "account" || view === "friends") render();
  runSync();
  refreshFriends();
  refreshTogether();
});
