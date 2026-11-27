// Program sayfası: haftalık tablo, blok ekleme/düzenleme penceresi, "plan ve gerçek" kartı.
// Ayrıca zamanlayıcı ekranındaki "Programda şimdi" kartı.
//
// main.ts'teki ortak şeyleri (ekranı yeniden çizmek, üst çubuk, eşitleme) bir "ctx" nesnesiyle alıyoruz.
// C++ benzetmesi: fonksiyona referans olarak geçirilen bir struct; içinde birkaç fonksiyon işaretçisi var.

import { toast } from "./effects";
import { dayKey, GENERAL, loadSubjects, statsBySubject } from "./storage";
import {
  activeBlocks,
  blockLabel,
  blocksOn,
  currentStudyBlock,
  DAY_NAMES,
  DAY_SHORT,
  deleteBlock,
  layoutDay,
  mondayOf,
  plannedByProject,
  putBlock,
  weekdayOf,
  type Block,
} from "./timetable";
import { clockText, escapeHtml, formatMinutes, projectColor } from "./util";
import {
  connectGoogle,
  disconnectGoogle,
  externalOn,
  gcalStatus,
  matchProject,
  preloadGoogle,
  type ExtEvent,
} from "./gcal";

export interface TimetableCtx {
  app: HTMLElement;
  modalRoot: HTMLElement;
  headerHtml: () => string;
  pageHeadHtml: (kicker: string, title: string, sub?: string) => string;
  rerender: () => void; // main.ts'teki render()
  changed: () => void; // bir blok değişti: buluta eşitle
  isDesktop: () => boolean;
  userId: () => string | undefined; // Gazzla'ya giriş yapılmışsa kullanıcı kimliği
  fetchWeek: (weekOffset: number, force?: boolean) => void; // o haftanın Google etkinliklerini indir
  syncGoogle: () => Promise<void>; // Google ile hemen eşitle
}

let weekOffset = 0; // 0 = bu hafta, 1 = gelecek hafta, -1 = geçen hafta
let phoneDay = weekdayOf(new Date()); // telefonda gösterilen gün (0 = pazartesi)

const FIXED_COLOR = "#94a0b8";

function colorOf(b: Block): string {
  return b.kind === "fixed" ? FIXED_COLOR : b.subject ? projectColor(b.subject) : FIXED_COLOR;
}

function dayOfWeek(i: number): Date {
  const d = mondayOf(weekOffset);
  d.setDate(d.getDate() + i);
  return d;
}

function weekTitle(): string {
  if (weekOffset === 0) return "Bu hafta";
  if (weekOffset === 1) return "Gelecek hafta";
  if (weekOffset === -1) return "Geçen hafta";
  const first = dayOfWeek(0);
  const last = dayOfWeek(6);
  const fmt = (d: Date) => d.toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  return `${fmt(first)} – ${fmt(last)}`;
}

// ---------- Sayfa ----------

/** Tabloda tek bir kutu: Gazzla bloğu ya da Google'daki bir etkinlik (sadece gösterilir). */
type Item = { start: number; end: number; block?: Block; ext?: ExtEvent };
let shownExt = new Map<string, ExtEvent>(); // tıklanınca bulmak için

/** Haftanın planlanan çalışması: Gazzla blokları + adı bir projeyle aynı olan Google etkinlikleri. */
function plannedWithExternal(userId: string | undefined, offset: number): Map<string, number> {
  const planned = plannedByProject(offset, GENERAL);
  const monday = mondayOf(offset);
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    for (const e of externalOn(userId, d)) {
      const project = e.allDay ? undefined : matchProject(e.title);
      if (project) planned.set(project, (planned.get(project) ?? 0) + (e.end - e.start));
    }
  }
  return planned;
}

export function renderTimetable(ctx: TimetableCtx): void {
  const userId = ctx.userId();
  const blocks = activeBlocks();
  const planned = plannedWithExternal(userId, weekOffset);
  const plannedTotal = [...planned.values()].reduce((a, b) => a + b, 0);
  const doneTotal = weekOffset === 0 ? statsBySubject().reduce((a, r) => a + r.weekMin, 0) : 0;
  const g = gcalStatus(userId);
  if (g.connected && userId) ctx.fetchWeek(weekOffset); // arka planda; gelince ekran yenilenir

  const extByDay = Array.from({ length: 7 }, (_, i) => externalOn(userId, dayOfWeek(i)));
  const anyExt = extByDay.some((l) => l.length > 0);

  let sub: string;
  if (blocks.length === 0 && !anyExt) sub = "Boş bir saate dokunarak ilk bloğunu ekle. Dersler, çalışma saatleri, hepsi burada.";
  else if (plannedTotal === 0) sub = "Bu hafta hiç çalışma bloğu yok. Boş bir saate dokun, bir tane koy!";
  else if (weekOffset === 0)
    sub = `Bu hafta <b>${formatMinutes(plannedTotal)}</b> çalışma planladın, <b>${formatMinutes(Math.floor(doneTotal))}</b> yaptın.`;
  else sub = `Bu haftada <b>${formatMinutes(plannedTotal)}</b> çalışma planlı.`;

  const desktop = ctx.isDesktop();
  const shownDays = desktop ? [0, 1, 2, 3, 4, 5, 6] : [phoneDay];

  // Her günün kutuları: Gazzla blokları + Google'daki saatli etkinlikler.
  shownExt = new Map();
  const itemsOf = (i: number): Item[] => [
    ...blocksOn(dayOfWeek(i), blocks).map((b) => ({ start: b.start, end: b.end, block: b })),
    ...extByDay[i].filter((e) => !e.allDay).map((e) => ({ start: e.start, end: e.end, ext: e })),
  ];

  // Saat aralığı: varsayılan 08–20, bu haftaki kutulara göre genişler.
  let fromH = 8;
  let toH = 20;
  for (let i = 0; i < 7; i++) {
    for (const it of itemsOf(i)) {
      fromH = Math.min(fromH, Math.floor(it.start / 60));
      toH = Math.max(toH, Math.ceil(it.end / 60));
    }
  }
  const rows = toH - fromH;
  const todayKey = dayKey(new Date());
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const times = Array.from({ length: rows + 1 }, (_, i) =>
    `<span style="top:calc(var(--hour) * ${i})">${clockText((fromH + i) * 60)}</span>`,
  ).join("");

  const extKey = (e: ExtEvent) => `${e.date}|${e.id}`;
  const allDayChips = (i: number) =>
    extByDay[i]
      .filter((e) => e.allDay)
      .map((e) => {
        shownExt.set(extKey(e), e);
        return `<button type="button" class="tt-allday" data-ext="${escapeHtml(extKey(e))}" style="--c:${e.color}" title="${escapeHtml(e.title)} · ${escapeHtml(e.calendar)}">${escapeHtml(e.title)}</button>`;
      })
      .join("");

  const heads = shownDays
    .map((i) => {
      const d = dayOfWeek(i);
      const today = dayKey(d) === todayKey;
      return `<div class="tt-col-head ${today ? "today" : ""}"><span>${DAY_SHORT[i]}</span><b>${d.getDate()}</b>
        <div class="tt-alldays">${allDayChips(i)}</div></div>`;
    })
    .join("");

  const cols = shownDays
    .map((i) => {
      const d = dayOfWeek(i);
      const today = dayKey(d) === todayKey;
      const items = layoutDay(itemsOf(i))
        .map(({ item, lane, lanes }) => {
          const top = (item.start - fromH * 60) / 60;
          const height = (item.end - item.start) / 60;
          const past = weekOffset < 0 || (today && item.end <= nowMin) || (weekOffset === 0 && weekdayOf(d) < weekdayOf(now));
          const pos = `top:calc(var(--hour) * ${top.toFixed(4)});height:calc(var(--hour) * ${height.toFixed(4)});
                     left:calc(${((lane / lanes) * 100).toFixed(3)}% + 2px);width:calc(${(100 / lanes).toFixed(3)}% - 4px)`;
          const time = `${clockText(item.start)}–${clockText(item.end)}`;
          const cls = `${past ? "past" : ""} ${height < 0.75 ? "short" : ""}`;
          if (item.ext) {
            const e = item.ext;
            shownExt.set(extKey(e), e);
            const project = matchProject(e.title);
            const label = escapeHtml(e.title);
            return `
              <button type="button" class="tt-block ext ${project ? "matched" : ""} ${cls}" data-ext="${escapeHtml(extKey(e))}"
                style="${pos};--c:${project ? projectColor(project) : e.color}" title="${label} · ${time} · ${escapeHtml(e.calendar)}">
                <span class="tt-b-title">${label}</span>
                <span class="tt-b-time">${time}</span>
              </button>`;
          }
          const b = item.block!;
          const label = escapeHtml(blockLabel(b, GENERAL));
          return `
            <button type="button" class="tt-block ${b.kind} ${cls}" data-id="${b.id}"
              style="${pos};--c:${colorOf(b)}" title="${label} · ${time}">
              <span class="tt-b-title">${label}</span>
              <span class="tt-b-time">${time}${b.date ? " · tek sefer" : ""}</span>
            </button>`;
        })
        .join("");
      const nowLine =
        today && nowMin >= fromH * 60 && nowMin <= toH * 60
          ? `<div class="tt-now" style="top:calc(var(--hour) * ${((nowMin - fromH * 60) / 60).toFixed(4)})"></div>`
          : "";
      return `<div class="tt-col-body ${today ? "today" : ""}" data-day="${i}">${items}${nowLine}</div>`;
    })
    .join("");

  const dayTabs = desktop
    ? ""
    : `<div class="tt-daytabs">${DAY_SHORT.map((name, i) => {
        const d = dayOfWeek(i);
        const count = blocksOn(d, blocks).length + extByDay[i].length;
        return `<button type="button" class="tt-daytab ${i === phoneDay ? "selected" : ""} ${dayKey(d) === todayKey ? "today" : ""}" data-day="${i}">
          <span>${name}</span><b>${d.getDate()}</b>${count ? `<i></i>` : `<i class="none"></i>`}</button>`;
      }).join("")}</div>`;
  const phoneAllDay = desktop ? "" : allDayChips(phoneDay);

  ctx.app.innerHTML = `
    ${ctx.headerHtml()}
    ${ctx.pageHeadHtml("Program", `Haftalık <span class="grad-text">programın</span>`, sub)}
    <section class="tt-toolbar">
      <div class="tt-weeknav">
        <button type="button" class="icon round" id="tt-prev" title="Önceki hafta" aria-label="Önceki hafta">‹</button>
        <button type="button" class="tt-weekname" id="tt-this" title="Bu haftaya dön">${weekTitle()}</button>
        <button type="button" class="icon round" id="tt-next" title="Sonraki hafta" aria-label="Sonraki hafta">›</button>
      </div>
      <button type="button" class="small primary" id="tt-add">+ Blok ekle</button>
    </section>
    <section class="card tt-card">
      ${dayTabs}
      ${phoneAllDay ? `<div class="tt-alldays phone">${phoneAllDay}</div>` : ""}
      <div class="tt ${desktop ? "week" : "day"}" style="--rows:${rows}">
        ${desktop ? `<div class="tt-head"><span></span>${heads}</div>` : ""}
        <div class="tt-body">
          <div class="tt-times">${times}</div>
          ${cols}
        </div>
      </div>
    </section>
    ${planCardHtml(planned, weekOffset)}
    ${googleCardHtml(ctx)}`;

  bind(ctx, fromH);
}

// ---------- Google Calendar kartı ----------

function googleCardHtml(ctx: TimetableCtx): string {
  const userId = ctx.userId();
  const g = gcalStatus(userId);
  if (!g.configured) return "";
  const icon = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 9.5h17M8 2.5v4M16 2.5v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  let body: string;
  if (!userId) {
    body = `<p class="muted gcal-text">Google Calendar bağlantısı için önce <b>Hesap</b> sayfasından Gazzla'ya giriş yap.</p>`;
  } else if (!g.connected) {
    preloadGoogle().catch(() => {}); // düğmeye basınca pencere hemen açılsın
    body = `
      <p class="muted gcal-text">Bağlayınca blokların Google'da <b>Gazzla</b> takviminde görünür, Google'daki dersler ve
        etkinlikler de burada. Bir kez izin vermen yeter, sonrası kendiliğinden.</p>
      <button type="button" class="small primary" id="gcal-connect">Google Calendar'ı bağla</button>`;
  } else {
    const when = g.lastSync
      ? new Date(g.lastSync).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
      : undefined;
    const state = g.busy
      ? "Eşitleniyor…"
      : g.error
        ? `<span class="gcal-err">Eşitlenemedi: ${escapeHtml(g.error)}</span>`
        : when
          ? `Bağlı · son eşitleme ${when}`
          : "Bağlı";
    body = `
      <p class="muted gcal-text">${state}</p>
      <div class="gcal-actions">
        <button type="button" class="small ghost" id="gcal-sync" ${g.busy ? "disabled" : ""}>Şimdi eşitle</button>
        <button type="button" class="small ghost" id="gcal-disconnect">Bağlantıyı kes</button>
      </div>`;
  }
  return `
    <section class="card gcal-card">
      <div class="card-head"><div class="card-title gcal-title">${icon} Google Calendar</div>
        ${g.connected ? `<span class="live-dot" title="Bağlı"></span>` : ""}</div>
      ${body}
    </section>`;
}

/** Planlanan ve yapılan süre, projeye göre. */
function planCardHtml(planned: Map<string, number>, offset: number): string {
  if (planned.size === 0) return "";
  const done = new Map(statsBySubject().map((r) => [r.subject, r.weekMin]));
  const thisWeek = offset === 0;
  const rows = [...planned.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, plan]) => {
      const did = done.get(name) ?? 0;
      const pct = Math.min(100, (did / plan) * 100);
      const color = name === GENERAL ? FIXED_COLOR : projectColor(name);
      return `
        <li class="prow">
          <i class="chip-dot" style="--c:${color}"></i>
          <div class="prow-main">
            <div class="prow-top">
              <span class="prow-name">${escapeHtml(name)}</span>
              <span class="pgoal-nums">${thisWeek ? `<b>${formatMinutes(Math.floor(did))}</b> / ` : ""}${formatMinutes(plan)}${thisWeek && did >= plan ? " ✅" : ""}</span>
            </div>
            ${thisWeek ? `<div class="bar thin"><div class="fill" style="width:${pct}%;background:${color}"></div></div>` : ""}
          </div>
        </li>`;
    })
    .join("");
  return `
    <section class="card tt-plan">
      <div class="card-head">
        <div class="card-title">${thisWeek ? "Plan ve gerçek" : "Planlanan çalışma"}</div>
        <span class="muted card-meta">${thisWeek ? "yapılan / planlanan" : weekTitle().toLowerCase()}</span>
      </div>
      <ul class="prows">${rows}</ul>
    </section>`;
}

function bind(ctx: TimetableCtx, fromH: number): void {
  const q = <T extends Element = HTMLElement>(sel: string) => ctx.app.querySelector<T>(sel);
  q("#tt-prev")?.addEventListener("click", () => {
    weekOffset--;
    ctx.rerender();
  });
  q("#tt-next")?.addEventListener("click", () => {
    weekOffset++;
    ctx.rerender();
  });
  q("#tt-this")?.addEventListener("click", () => {
    weekOffset = 0;
    phoneDay = weekdayOf(new Date());
    ctx.rerender();
  });
  q("#tt-add")?.addEventListener("click", () => {
    const day = ctx.isDesktop() ? weekdayOf(new Date()) : phoneDay;
    const start = Math.min(22 * 60, Math.ceil((new Date().getHours() * 60 + 1) / 60) * 60);
    openBlockModal(ctx, { day, start });
  });
  ctx.app.querySelectorAll<HTMLButtonElement>(".tt-daytab").forEach((b) =>
    b.addEventListener("click", () => {
      phoneDay = Number(b.dataset.day);
      ctx.rerender();
    }),
  );

  // Boş bir yere dokununca o saatten başlayan yeni blok.
  ctx.app.querySelectorAll<HTMLElement>(".tt-col-body").forEach((col) =>
    col.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tt-block")) return;
      const rect = col.getBoundingClientRect();
      const hourPx = parseFloat(getComputedStyle(col).getPropertyValue("--hour")) || 48;
      const min = fromH * 60 + ((e.clientY - rect.top) / hourPx) * 60;
      const start = Math.max(0, Math.min(23 * 60, Math.floor(min / 30) * 30)); // yarım saate yuvarla
      openBlockModal(ctx, { day: Number(col.dataset.day), start });
    }),
  );

  ctx.app.querySelectorAll<HTMLButtonElement>(".tt-block, .tt-allday").forEach((el) =>
    el.addEventListener("click", () => {
      if (el.dataset.ext) {
        const ext = shownExt.get(el.dataset.ext);
        if (ext) openExtModal(ctx, ext);
        return;
      }
      const block = activeBlocks().find((b) => b.id === el.dataset.id);
      if (block) openBlockModal(ctx, { block });
    }),
  );

  // Google Calendar kartı
  q("#gcal-connect")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const userId = ctx.userId();
    if (!userId) return;
    btn.disabled = true;
    btn.textContent = "Google penceresi açık…";
    try {
      await connectGoogle(userId); // pencere bu tıklamanın içinde açılıyor
      toast("Google Calendar bağlandı. Gazzla!");
      await ctx.syncGoogle();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    ctx.rerender();
  });
  q("#gcal-sync")?.addEventListener("click", async () => {
    await ctx.syncGoogle();
    ctx.fetchWeek(weekOffset, true);
    const g = gcalStatus(ctx.userId());
    toast(g.error ? `Eşitlenemedi: ${g.error}` : "Google ile eşitlendi.");
  });
  q("#gcal-disconnect")?.addEventListener("click", async () => {
    const userId = ctx.userId();
    if (!userId) return;
    if (!confirm("Google Calendar bağlantısı kesilsin mi? Google'daki \"Gazzla\" takvimi silinmez, istersen Google'dan kendin silebilirsin."))
      return;
    try {
      await disconnectGoogle(userId);
      toast("Google bağlantısı kesildi.");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    ctx.rerender();
  });
}

// ---------- Google etkinliği penceresi (sadece bilgi) ----------

function openExtModal(ctx: TimetableCtx, e: ExtEvent): void {
  const project = e.allDay ? undefined : matchProject(e.title);
  const date = new Date(e.date + "T12:00").toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
  ctx.modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal card tt-modal">
        <div class="ext-head">
          <i class="chip-dot" style="--c:${e.color}"></i>
          <div>
            <div class="card-title ext-title">${escapeHtml(e.title)}</div>
            <div class="muted small-note">${date} · ${e.allDay ? "tüm gün" : `${clockText(e.start)}–${clockText(e.end)}`}</div>
          </div>
        </div>
        <p class="muted ext-note">Google Calendar'daki <b>${escapeHtml(e.calendar)}</b> takviminden.
          ${project ? `Adı <b>${escapeHtml(project)}</b> projesiyle aynı, o yüzden planına sayılıyor.` : "Gazzla bunu sadece gösteriyor, değiştirmiyor."}</p>
        <div class="row">
          ${e.link ? `<a class="btn-link secondary" href="${escapeHtml(e.link)}" target="_blank" rel="noopener">Google'da aç</a>` : ""}
          <button type="button" class="secondary" id="ext-close">Kapat</button>
        </div>
      </div>
    </div>`;
  const close = () => (ctx.modalRoot.innerHTML = "");
  ctx.modalRoot.querySelector("#ext-close")!.addEventListener("click", close);
  ctx.modalRoot.querySelector(".modal-backdrop")!.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) close();
  });
}

// ---------- Blok penceresi ----------

const toMin = (value: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

function openBlockModal(ctx: TimetableCtx, opts: { block?: Block; day?: number; start?: number }): void {
  const editing = opts.block;
  let kind: Block["kind"] = editing?.kind ?? "study";
  let subject: string | undefined = editing ? editing.subject : loadSubjects()[0];
  let day = editing ? (editing.date ? weekdayOf(new Date(editing.date + "T12:00")) : editing.weekday!) : (opts.day ?? 0);
  const start = editing?.start ?? opts.start ?? 9 * 60;
  const end = editing?.end ?? Math.min(24 * 60, start + 120);
  const repeat = editing ? editing.date === undefined : true;

  const subjects = loadSubjects();
  if (subject !== undefined && !subjects.includes(subject)) subjects.push(subject); // silinmiş proje de seçili görünsün
  const projectChips = [
    `<button type="button" class="chip" data-subj=""><i class="chip-dot general"></i>Genel çalışma</button>`,
    ...subjects.map(
      (s) =>
        `<button type="button" class="chip" data-subj="${escapeHtml(s)}"><i class="chip-dot" style="--c:${projectColor(s)}"></i>${escapeHtml(s)}</button>`,
    ),
  ].join("");
  const dayChips = DAY_SHORT.map((n, i) => `<button type="button" class="chip" data-day="${i}" title="${DAY_NAMES[i]}">${n}</button>`).join("");

  ctx.modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <form class="modal card tt-modal" id="tt-form" novalidate>
        <div class="card-title">${editing ? "Bloğu düzenle" : "Yeni blok"}</div>
        <div class="seg">
          <button type="button" data-kind="study">Çalışma</button>
          <button type="button" data-kind="fixed">Sabit (ders, etkinlik)</button>
        </div>
        <div class="tt-field study-only"><span class="muted">Proje</span><div class="chips">${projectChips}</div></div>
        <label class="tt-field fixed-only"><span class="muted">Ad</span>
          <input id="tt-title" type="text" maxlength="60" placeholder="Örn. Lineare Algebra dersi" autocomplete="off"
                 value="${escapeHtml(editing?.title ?? "")}" /></label>
        <div class="tt-field"><span class="muted">Gün</span><div class="chips tt-days">${dayChips}</div></div>
        <div class="tt-timepair">
          <label class="tt-field"><span class="muted">Başlangıç</span><input id="tt-start" type="time" step="300" value="${clockText(start)}" /></label>
          <label class="tt-field"><span class="muted">Bitiş</span><input id="tt-end" type="time" step="300" value="${end >= 1440 ? "23:59" : clockText(end)}" /></label>
        </div>
        <label class="tt-check"><input id="tt-repeat" type="checkbox" ${repeat ? "checked" : ""} /> Her hafta tekrarla</label>
        <p class="tt-error" id="tt-error"></p>
        <div class="row">
          ${editing ? `<button type="button" class="secondary danger" id="tt-delete">Sil</button>` : ""}
          <button type="button" class="secondary" id="tt-cancel">Vazgeç</button>
          <button type="submit" class="primary">Kaydet</button>
        </div>
      </form>
    </div>`;

  const root = ctx.modalRoot;
  const form = root.querySelector<HTMLFormElement>("#tt-form")!;
  const titleInput = root.querySelector<HTMLInputElement>("#tt-title")!;
  const errorEl = root.querySelector<HTMLElement>("#tt-error")!;

  const refresh = () => {
    form.dataset.kind = kind; // CSS .study-only / .fixed-only'i buna göre gösterir
    root.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => b.classList.toggle("selected", b.dataset.kind === kind));
    root.querySelectorAll<HTMLButtonElement>("[data-subj]").forEach((b) =>
      b.classList.toggle("selected", (b.dataset.subj || undefined) === subject),
    );
    root.querySelectorAll<HTMLButtonElement>(".tt-days [data-day]").forEach((b) =>
      b.classList.toggle("selected", Number(b.dataset.day) === day),
    );
  };
  refresh();

  root.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) =>
    b.addEventListener("click", () => {
      kind = b.dataset.kind as Block["kind"];
      refresh();
      if (kind === "fixed") titleInput.focus();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-subj]").forEach((b) =>
    b.addEventListener("click", () => {
      subject = b.dataset.subj || undefined;
      refresh();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>(".tt-days [data-day]").forEach((b) =>
    b.addEventListener("click", () => {
      day = Number(b.dataset.day);
      refresh();
    }),
  );

  const close = () => (root.innerHTML = "");
  root.querySelector("#tt-cancel")!.addEventListener("click", close);
  root.querySelector(".modal-backdrop")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  root.querySelector("#tt-delete")?.addEventListener("click", () => {
    deleteBlock(editing!.id);
    close();
    ctx.changed();
    ctx.rerender();
    toast("Blok silindi.");
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const s = toMin(root.querySelector<HTMLInputElement>("#tt-start")!.value);
    let en = toMin(root.querySelector<HTMLInputElement>("#tt-end")!.value);
    if (en === 23 * 60 + 59) en = 24 * 60; // 23:59 = gün sonuna kadar
    const title = titleInput.value.trim();
    const fail = (msg: string) => (errorEl.textContent = msg);
    if (s === undefined || en === undefined) return fail("Başlangıç ve bitiş saatini gir.");
    if (en <= s) return fail("Bitiş, başlangıçtan sonra olmalı.");
    if (en - s < 10) return fail("Blok en az 10 dakika olmalı.");
    if (kind === "fixed" && !title) {
      titleInput.focus();
      return fail("Sabit bloğa bir ad ver (ör. Lineare Algebra dersi).");
    }

    const repeatEach = root.querySelector<HTMLInputElement>("#tt-repeat")!.checked;
    const block: Block = {
      id: editing?.id ?? crypto.randomUUID(),
      kind,
      subject: kind === "study" ? subject : undefined,
      title: kind === "fixed" ? title : undefined,
      weekday: repeatEach ? day : undefined,
      date: repeatEach ? undefined : dayKey(dayOfWeek(day)),
      start: s,
      end: en,
      updatedAt: Date.now(),
    };
    putBlock(block);
    close();
    if (!ctx.isDesktop()) phoneDay = day; // telefonda eklenen günü göster
    ctx.changed();
    ctx.rerender();
    toast(editing ? "Blok güncellendi." : "Blok eklendi. Gazzla!");
    // Blok başlayınca haber verebilmek için bildirim izni (yalnız ilk seferde sorulur).
    if (kind === "study" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  });

  (kind === "fixed" ? titleInput : root.querySelector<HTMLButtonElement>(".seg button.selected"))?.focus();
}

/** İstatistik sayfası için: bu haftanın planı ve gerçekleşen (programda çalışma bloğu yoksa boş). */
export function weekPlanCardHtml(userId: string | undefined): string {
  return planCardHtml(plannedWithExternal(userId, 0), 0);
}

// ---------- Zamanlayıcı ekranındaki "Programda şimdi" kartı ----------

/** Şu an (ya da birazdan) çalışma bloğu varsa küçük kart; yoksa boş metin. */
export function nowBlockHtml(focusSubject: string | undefined, userId: string | undefined): string {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Önce Gazzla'nın kendi çalışma blokları; yoksa adı bir projeyle aynı olan Google etkinliği.
  let found: { subject?: string; start: number; end: number; startsIn: number } | undefined;
  const own = currentStudyBlock(now);
  if (own) found = { subject: own.block.subject, start: own.block.start, end: own.block.end, startsIn: own.startsIn };
  else {
    const ext = externalOn(userId, now)
      .filter((e) => !e.allDay && matchProject(e.title))
      .find((e) => (e.start <= nowMin && nowMin < e.end) || (e.start > nowMin && e.start - nowMin <= 15));
    if (ext) found = { subject: matchProject(ext.title), start: ext.start, end: ext.end, startsIn: Math.max(0, ext.start - nowMin) };
  }
  if (!found) return "";
  const { subject, startsIn } = found;
  if (focusSubject !== undefined && subject !== focusSubject) return ""; // başka projenin ekranındayız
  const left = found.end - Math.max(nowMin, found.start);
  const minutes = Math.max(5, Math.min(90, Math.round(left / 5) * 5));
  const name = escapeHtml(subject ?? GENERAL);
  const when = startsIn > 0 ? `${startsIn} dk sonra` : "Programda şimdi";
  return `
    <section class="card now-block" style="--c:${subject ? projectColor(subject) : FIXED_COLOR}">
      <div class="now-block-text">
        <span class="setup-kicker">${when}</span>
        <strong>${name}</strong>
        <span class="muted small-note">${clockText(found.start)}–${clockText(found.end)}</span>
      </div>
      <button type="button" class="small primary" id="start-block" data-subject="${escapeHtml(subject ?? "")}" data-min="${minutes}">
        Başlat · ${minutes} dk</button>
    </section>`;
}
