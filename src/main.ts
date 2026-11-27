// Uygulamanın giriş noktası: ekranı çizer ve düğmeleri bağlar.
// Akış: süre gir → çalış → bitince ara mı, yeni seans mı?

import "./style.css";
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
let view: "timer" | "stats" | "subjects" | "account" | "friends" = "timer";
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

function headerHtml(): string {
  const streak = currentStreak(settings.dailyGoalMin);
  return `
    <header>
      <div class="header-left">
        <button id="open-menu" class="icon big" title="Menü">☰</button>
        <h1 class="logo">Gazzla</h1>
      </div>
      <div class="header-right">
        <div class="streak ${streak > 0 ? "on" : ""}" title="Üst üste hedef tutturduğun gün sayısı">
          🔥 ${streak} gün
        </div>
        <button id="toggle-view" class="icon big" title="${view === "timer" ? "İstatistikler" : "Zamanlayıcı"}">
          ${view === "timer" ? "📊" : "⏱️"}
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
            <stop offset="0%" stop-color="#ff7a18" />
            <stop offset="100%" stop-color="#ffd166" />
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

function render(): void {
  clearInterval(hypeInterval);
  const running = phase === "work" || phase === "break";

  if (view === "stats") {
    renderStats();
  } else if (view === "subjects") {
    renderSubjects();
  } else if (view === "account") {
    renderAccount();
  } else if (view === "friends") {
    renderFriends();
  } else if (running) {
    const subtitle =
      phase === "work" ? escapeHtml(currentSubject ?? "Genel çalışma") : "Ara";
    app.innerHTML = `
      ${headerHtml()}
      ${goalHtml()}
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
      ${goalHtml()}
      ${ringHtml(
        settings.fixedDurations ? formatTime(settings.defaultWorkMin * 60_000) : "Hazır",
        askingNext ? "Sırada ne var?" : "Bir seans başlat",
        "idle",
      )}
      <p class="hype">${escapeHtml(hypeMessage)}</p>
      <p id="together" class="together"></p>
      <section class="card form">
        ${
          settings.fixedDurations
            ? ""
            : `<label>Süre (dakika)
                 <input id="minutes" type="number" min="1" value="${settings.defaultWorkMin}" />
               </label>`
        }
        ${focusSubject ? lockedSubjectHtml() : subjectPickerHtml()}
      </section>
      <div class="row">
        <button id="work" class="primary">Gazla 🚀</button>
        ${askingNext ? `<button id="break" class="secondary">Ara ver ☕</button>` : ""}
      </div>
      ${focusSubject ? subjectStatsHtml(focusSubject) : ""}`;

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
}

/** Projeler tıklanabilir "chip" olarak; sonda yeni proje penceresini açan "+ Proje" butonu. */
function subjectPickerHtml(): string {
  const subjects = loadSubjects();
  // Seçili ders listeden silindiyse seçimi "Genel"e döndür.
  if (currentSubject && !subjects.includes(currentSubject)) currentSubject = undefined;

  const chip = (value: string, label: string) => {
    const selected = (currentSubject ?? "") === value;
    return `<button class="chip ${selected ? "selected" : ""}" data-subject="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
  };

  return `
    <div class="subject-picker">
      <span class="picker-title">Ne için çalışıyorsun? <span class="muted">(isteğe bağlı)</span></span>
      <div class="chips">
        ${chip("", "Genel")}
        ${subjects.map((s) => chip(s, s)).join("")}
        <button id="new-project" class="chip add" title="Yeni proje ekle">+ Proje</button>
      </div>
    </div>`;
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
    toast(`${name} eklendi. Gazla!`);
  });
}

// ---------- Sol menü ----------
// Menü #app'in dışında, ayrı bir kutuda çiziliyor. Böylece render() ana ekranı baştan çizse bile
// menü kapanmıyor, menüyü açıp kapamak da ana ekranı (ve yazdığın süreyi) bozmuyor.

const menuRoot = document.createElement("div");
document.body.append(menuRoot);

function renderMenu(): void {
  if (!menuOpen) {
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
    <div class="menu-backdrop"></div>
    <nav class="menu">
      <div class="menu-head">
        <span class="logo small-logo">Gazzla</span>
        <button class="icon big menu-close" title="Kapat">✕</button>
      </div>
      <button class="menu-item ${!focusSubject && view === "timer" ? "active" : ""}" data-go="home" ${lock}>🏠 Ana ekran</button>
      <div class="menu-section">Projeler</div>
      ${subjectItems}
      ${running ? `<p class="muted small-note menu-empty">Seans sürerken proje değiştirilemez.</p>` : ""}
      <div class="menu-section"></div>
      <button class="menu-item" data-go="subjects" ${lock}>📚 Projeleri yönet</button>
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
  menuRoot.querySelector(".menu-backdrop")!.addEventListener("click", close);
  menuRoot.querySelector(".menu-close")!.addEventListener("click", close);

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
}

/** Aktif arkadaşları Supabase'den yeniden al. */
async function refreshTogether(): Promise<void> {
  if (!authUser) {
    activeFriends = [];
    return;
  }
  activeFriends = await loadActiveFriends(authUser.id);
  updateTogetherLine();
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
        <p class="muted small-note">Çalışma kayıtların bu hesaba yükleniyor; aynı hesapla telefondan girince
          orada da görünür. Proje listesi ve hedefler şimdilik cihaza özel.</p>
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
  const maxDay = Math.max(goalMin ?? 1, ...days.map((d) => d.minutes));
  const bars = days
    .map((d) => {
      const pct = (d.minutes / maxDay) * 100;
      const met = goalMin !== undefined && d.minutes >= goalMin;
      return `
        <div class="day">
          <div class="day-bar"><div class="day-fill ${met ? "met" : ""}" style="height:${pct}%"></div></div>
          <span class="day-label">${d.label}</span>
          <span class="day-min">${Math.round(d.minutes)}</span>
        </div>`;
    })
    .join("");
  const goalLine =
    goalMin !== undefined
      ? `<div class="goal-line" style="bottom:${40 + (goalMin / maxDay) * 100 * 1.2}px"><span>hedef</span></div>`
      : "";
  return `<div class="days">${goalLine}${bars}</div>`;
}

function renderStats(): void {
  const rows = statsBySubject();
  const days = lastSevenDays();
  const weekTotal = rows.reduce((sum, r) => sum + r.weekMin, 0);
  const weekPct = Math.round((weekTotal / settings.weeklyGoalMin) * 100);
  const allTotal = rows.reduce((sum, r) => sum + r.totalMin, 0);


  const subjectRows = rows.length
    ? rows
        .map(
          (r) => `
        <tr>
          <td>${escapeHtml(r.subject)}</td>
          <td>${formatMinutes(r.todayMin)}</td>
          <td>${formatMinutes(r.weekMin)}</td>
          <td><strong>${formatMinutes(r.totalMin)}</strong></td>
        </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="muted">Henüz kayıt yok. İlk seansı başlat!</td></tr>`;

  app.innerHTML = `
    ${headerHtml()}
    <section class="card totals">
      <div>
        <span class="muted">Bu hafta</span>
        <strong>${formatMinutes(weekTotal)}</strong>
        <span class="muted small-note">hedefin %${weekPct}'i ${weekPct >= 100 ? "✅" : ""}</span>
      </div>
      <div><span class="muted">Duraklatma (hafta)</span><strong>${weekPauseCount()} kez</strong></div>
      <div><span class="muted">Toplam</span><strong>${formatMinutes(allTotal)}</strong></div>
    </section>
    <section class="card">
      <div class="card-title">Son 7 gün <span class="muted">(dk)</span></div>
      ${daysChartHtml(days, settings.dailyGoalMin)}
    </section>
    <section class="card">
      <div class="card-title">Projelere göre</div>
      <table class="subjects">
        <thead><tr><th>Proje</th><th>Bugün</th><th>Hafta</th><th>Toplam</th></tr></thead>
        <tbody>${subjectRows}</tbody>
      </table>
    </section>`;
}

function bindGoalEditing(): void {
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
