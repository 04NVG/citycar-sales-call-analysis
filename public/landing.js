"use strict";
/* Лендинг. Всё, что показывает данные, берёт их из demo-data.json, а проверка цитат
   повторяет call_analysis.py: цитата должна найтись в реплике того же говорящего. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FINE = matchMedia("(pointer: fine)").matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString("ru-RU");
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many; };
const norm = (t) => t.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}_\s]/gu, " ").replace(/\s+/g, " ").trim();

/* ================= навигация ================= */
function initNav() {
  const island = $("#island"), burger = $("#burger"), menu = $("#menu");
  const setMenu = (open) => {
    burger.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
    if (open) { menu.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add("open"))); }
    else { menu.classList.remove("open"); setTimeout(() => { if (!menu.classList.contains("open")) menu.hidden = true; }, REDUCED ? 0 : 420); }
  };
  burger.addEventListener("click", () => setMenu(burger.getAttribute("aria-expanded") !== "true"));
  $$("a", menu).forEach((a) => a.addEventListener("click", () => setMenu(false)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { setMenu(false); burger.focus(); } });
  matchMedia("(min-width: 901px)").addEventListener("change", (e) => { if (e.matches) setMenu(false); });

  const links = new Map($$(".island-nav a").map((a) => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) links.forEach((a, id) => a.classList.toggle("on", id === en.target.id)); });
  }, { rootMargin: "-45% 0px -50% 0px" });
  links.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  onScroll(() => island.classList.toggle("scrolled", scrollY > 40));
}

/* ================= один rAF-цикл на скролл ================= */
const scrollJobs = [];
let ticking = false;
function onScroll(fn) { scrollJobs.push(fn); fn(); }
addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { scrollJobs.forEach((f) => f()); ticking = false; });
}, { passive: true });
addEventListener("resize", () => scrollJobs.forEach((f) => f()), { passive: true });

/* ================= волны в первом экране: речь, которая становится сигналом ================= */
function initWaves() {
  const cv = $("#waves"); if (!cv) return;
  const ctx = cv.getContext("2d");
  let w = 0, h = 0, dpr = 1, t = 0, raf = 0, visible = true;
  const mouse = { x: .6, y: .5, tx: .6, ty: .5 };
  const LINES = 26;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    mouse.x += (mouse.tx - mouse.x) * .04; mouse.y += (mouse.ty - mouse.y) * .04;
    const mid = h * (w < 700 ? .34 : .5), cx = w * (w < 700 ? .5 : .55 + (mouse.x - .5) * .12), spread = w * .32;
    const step = Math.max(6, w / 160);
    for (let i = 0; i < LINES; i++) {
      const k = i / (LINES - 1), phase = i * .42;
      const amp = h * (.05 + .16 * Math.sin(k * Math.PI)) * (1 + (mouse.y - .5) * .3);
      ctx.beginPath();
      for (let x = -10; x <= w + 10; x += step) {
        const env = Math.exp(-(((x - cx) / spread) ** 2));
        const y = mid + (k - .5) * h * .22 * (1 - env * .6)
          + env * amp * (Math.sin(x * .011 + t * 1.3 + phase) * .6 + Math.sin(x * .023 - t * .9 + phase * 1.7) * .4);
        x === -10 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      const accent = i === 7 || i === 15;
      ctx.strokeStyle = accent ? `rgba(232,176,75,${.55 - k * .2})` : `rgba(237,234,227,${.05 + .1 * Math.sin(k * Math.PI)})`;
      ctx.lineWidth = accent ? 1.3 : 1;
      ctx.stroke();
    }
  };
  const loop = () => { t += .008; draw(); raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0; };
  const start = () => { if (!raf && !REDUCED) raf = requestAnimationFrame(loop); };
  resize(); draw();
  addEventListener("resize", () => { resize(); draw(); }, { passive: true });
  if (FINE) addEventListener("pointermove", (e) => { mouse.tx = e.clientX / innerWidth; mouse.ty = e.clientY / innerHeight; }, { passive: true });
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) start(); }).observe(cv);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) start(); });
  start();
}

/* ================= консоль: печатает запрос, отправляет в демо ================= */
function initConsole() {
  const form = $("#console"), input = $("#q");
  const full = input.value;
  let typing = !REDUCED;
  const stop = () => { if (typing) { typing = false; input.value = full; } };
  input.addEventListener("focus", stop);
  input.addEventListener("pointerdown", stop);
  if (typing) {
    input.value = "";
    let i = 0;
    setTimeout(function tick() {
      if (!typing) return;
      input.value = full.slice(0, ++i);
      if (i < full.length) setTimeout(tick, 22 + Math.random() * 40); else typing = false;
    }, 1100);
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", (e) => {
    e.preventDefault(); stop();
    const q = input.value.trim();
    location.href = `demo.html${q ? `?q=${encodeURIComponent(q)}` : ""}#report`;
  });
}

/* ================= появление и счётчики ================= */
function countUp(el) {
  const to = Number(el.dataset.count);
  if (REDUCED || !to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 1400;
  const tick = (now) => {
    const p = clamp((now - t0) / dur), e = 1 - Math.pow(2, -10 * p);
    el.textContent = fmt(Math.round(to * (p === 1 ? 1 : e)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function initReveal() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add("in");
      $$("[data-count]", en.target).forEach(countUp);
      if (en.target.matches("[data-count]")) countUp(en.target);
      en.target.dispatchEvent(new CustomEvent("revealed"));
      io.unobserve(en.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: .08 });
  $$("[data-reveal]").forEach((el) => io.observe(el));
}

/* ================= манифест: слова загораются по мере скролла ================= */
function initManifesto() {
  const p = $("#manifesto"), track = $("#manifestoTrack");
  const words = [];
  const split = (node) => {
    [...node.childNodes].forEach((ch) => {
      if (ch.nodeType === 3) {
        const frag = document.createDocumentFragment();
        ch.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(part); return; }
          const s = document.createElement("span"); s.className = "wd"; s.textContent = part; words.push(s); frag.append(s);
        });
        ch.replaceWith(frag);
      } else if (ch.nodeType === 1) split(ch);
    });
  };
  split(p);
  if (REDUCED) { words.forEach((w) => w.classList.add("lit")); track.style.height = "auto"; return; }
  onScroll(() => {
    const r = track.getBoundingClientRect();
    const prog = clamp(-r.top / Math.max(1, r.height - innerHeight) * 1.25);
    const n = Math.round(prog * words.length);
    words.forEach((w, i) => w.classList.toggle("lit", i < n));
  });
}

/* ================= журнал агентов ================= */
function initSteps() {
  const steps = $$("#steps .step"), list = $("#steps");
  const now = $("#stepNow"), who = $("#stepWho");
  let active = -1;
  const set = (i) => {
    if (i === active) return; active = i;
    steps.forEach((s, k) => s.classList.toggle("on", k <= i));
    list.style.setProperty("--prog", steps.length > 1 ? i / (steps.length - 1) : 1);
    now.textContent = i + 1;
    who.textContent = $("h3", steps[i]).firstChild.textContent.trim();
  };
  if (REDUCED) { set(steps.length - 1); return; }
  set(0);
  onScroll(() => {
    const line = innerHeight * .55;
    let idx = 0;
    steps.forEach((s, k) => { if (s.getBoundingClientRect().top < line) idx = k; });
    set(idx);
  });
}

/* ================= живое демо в 3D-рамке ================= */
function initStage() {
  const stage = $("#stage"), device = $("#device"), frame = $("#liveFrame"), veil = $("#veil");
  new IntersectionObserver(([en], io) => {
    if (en.isIntersecting) { frame.src = frame.dataset.src; io.disconnect(); }
  }, { rootMargin: "0px 0px -15% 0px" }).observe(stage);
  new IntersectionObserver(([en]) => { if (!en.isIntersecting) device.classList.remove("active"); }).observe(stage);
  veil.addEventListener("click", () => { device.classList.add("active"); frame.focus(); });
  if (REDUCED) { stage.style.setProperty("--p", 1); return; }
  onScroll(() => {
    const r = stage.getBoundingClientRect();
    stage.style.setProperty("--p", clamp((innerHeight - r.top) / (innerHeight * .85)).toFixed(3));
  });
}

/* ================= подсветка под курсором и магнитная кнопка ================= */
function initPointer() {
  if (!FINE) return;
  $$(".spot").forEach((c) => c.addEventListener("pointermove", (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty("--mx", `${e.clientX - r.left}px`); c.style.setProperty("--my", `${e.clientY - r.top}px`);
  }));
  if (REDUCED) return;
  $$(".magnetic").forEach((b) => {
    b.addEventListener("pointermove", (e) => {
      const r = b.getBoundingClientRect();
      b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .18}px, ${(e.clientY - r.top - r.height / 2) * .3}px)`;
    });
    b.addEventListener("pointerleave", () => { b.style.transform = ""; });
  });
}

/* ================= решение руководителя ================= */
function initDecision() {
  const acts = $$("#decideActs button"), state = $("#decideState");
  const label = { yes: "Утверждено: задача уйдёт ответственному.", later: "Отложено: рекомендация останется в очереди.", no: "Отклонено. В CRM ничего не изменено." };
  acts.forEach((b) => b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    acts.forEach((x) => x.setAttribute("aria-pressed", String(on && x === b)));
    state.textContent = on ? label[b.dataset.v] : "Система предлагает, но ничего не меняет в CRM.";
  }));
  acts.forEach((b) => b.setAttribute("aria-pressed", "false"));
}

/* ================= данные демо: инсайт, график, звонок ================= */
async function initData() {
  let d;
  try { d = await (await fetch("demo-data.json")).json(); } catch { return; }
  const fp = d.fact_pack, t = fp.team;
  const facts = new Set();
  (function walk(o) {
    if (typeof o === "number") facts.add(Math.round(o * 10) / 10);
    else if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") Object.values(o).forEach(walk);
  })(fp);

  /* наблюдение модели: каждое число сверяется с fact pack так же, как в демо */
  const ins = d.report.insights[0], insight = $("#insight");
  let k = 0;
  insight.innerHTML = esc(ins.text).replace(/(?<![\w.])(\d{1,3}(?:[  ]\d{3})+|\d+(?:[.,]\d+)?)(?![\w])/g, (m) => {
    const n = Math.round(Number(m.replace(/[  ]/g, "").replace(",", ".")) * 10) / 10;
    return facts.has(n) ? `<span class="n" style="--k:${k++}" title="Есть в fact pack">${m}</span>` : m;
  });
  const calls = new Map(d.calls.map((c) => [c.id, c])), leads = new Map(d.leads.map((l) => [l.id, l]));
  const ICO_CALL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>';
  const ICO_LEAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v12H4zM9 7V5h6v2"/></svg>';
  const ev = ins.evidence.map((id) => {
    if (calls.has(id)) {
      const c = calls.get(id), when = new Date(c.started_at * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
      return `<li>${ICO_CALL}<span>Звонок <b>${esc(when)}</b>, ${Math.round(c.duration_sec / 60) || 1} мин</span></li>`;
    }
    if (leads.has(id)) return `<li>${ICO_LEAD}<span>Сделка <b>${esc(leads.get(id).name)}</b></span></li>`;
    return "";
  }).join("");
  if (ev) { $("#evidence ul").innerHTML = ev; $("#evidence").hidden = false; }

  const v = d.report_validation;
  $("#verified").lastChild.textContent = `${v.numbers_checked} ${plural(v.numbers_checked, "число сверено", "числа сверено", "чисел сверено")}`;
  const cell = insight.closest("[data-reveal]");
  const check = () => setTimeout(() => insight.classList.add("checked"), REDUCED ? 0 : 500);
  cell.classList.contains("in") ? check() : cell.addEventListener("revealed", check, { once: true });

  /* отклонение от медианы по менеджерам */
  const an = fp.anomalies.find((a) => a.metric === "open_without_tasks_pct");
  $("#bars").innerHTML = d.managers.map((m) => {
    const val = fp.managers[m.id].open_without_tasks_pct, flag = an && an.manager_id === m.id;
    return `<div class="bar${flag ? " flag" : ""}"><span>${esc(m.name)}</span><i style="--v:${val}"></i><b>${val}%</b></div>`;
  }).join("");

  const rec = d.report.recommendations[0];
  $("#decideText").textContent = rec.text.replace(" — ", ": ");
  initCall(d.samples[0]);
}

function initCall(sample) {
  const ex = sample.extraction;
  const segs = sample.transcript.split("\n").map((line) => {
    const m = line.match(/^\[(\d+):(\d+)\]\s*(Менеджер|Клиент):\s*(.*)$/);
    return m && { start: +m[1] * 60 + +m[2], ts: `${m[1]}:${m[2]}`, speaker: m[3] === "Менеджер" ? "manager" : "customer", text: m[4] };
  }).filter(Boolean);
  const target = ex.evidence.find((e) => e.speaker === "customer" && /конкурент/i.test(e.quote)) || ex.evidence.find((e) => e.speaker === "customer");
  const seg0 = segs.find((s) => s.speaker === target.speaker && norm(s.text).includes(norm(target.quote)));
  const original = seg0.text, tampered = original.replace(target.quote, "Цена в целом устраивает");
  const last = segs[segs.length - 1].start;
  $(".phone-hd span").textContent = `${segs.length} ${plural(segs.length, "реплика", "реплики", "реплик")}, ${Math.floor(last / 60)} мин ${last % 60} с`;

  const chat = $("#chat"), tamper = $("#tamper"), task = $("#task"), verdict = $("#verdict");
  task.checked = sample.lead_has_open_task;

  const markup = (s) => {
    let html = esc(s.text);
    const edited = s === seg0 && tamper.checked;
    if (edited) return html.replace(esc("Цена в целом устраивает"), `<mark class="bad">Цена в целом устраивает</mark>`);
    ex.evidence.filter((e) => e.speaker === s.speaker && norm(s.text).includes(norm(e.quote))).forEach((e) => {
      html = html.replace(esc(e.quote), `<mark title="Цитата ${e.id}">${esc(e.quote)}</mark>`);
    });
    return html;
  };
  const render = (flash) => {
    seg0.text = tamper.checked ? tampered : original;
    chat.innerHTML = segs.map((s) => `<div class="msg ${s.speaker}${flash && s === seg0 ? " flash" : ""}"${s === seg0 ? ' id="tseg"' : ""}><small>${s.ts} ${s.speaker === "manager" ? "Менеджер" : "Клиент"}</small>${markup(s)}</div>`).join("");

    const bad = ex.evidence.filter((e) => !segs.some((s) => s.speaker === e.speaker && norm(s.text).includes(norm(e.quote))));
    const reasons = [];
    if (bad.length) reasons.push(`${bad.length} ${plural(bad.length, "цитата не найдена", "цитаты не найдены", "цитат не найдено")} в транскрипте: «${bad.map((e) => e.quote).join("», «")}».`);
    if (ex.next_step.agreed && !task.checked) reasons.push("Договорённость есть в разговоре, задачи в CRM нет. Код добавил риск «обещание без задачи».");
    const ok = !reasons.length;
    verdict.className = `verdict ${ok ? "" : "warn"}`;
    void verdict.offsetWidth; verdict.classList.add("swap");
    $("#verdictTitle").textContent = ok ? "Разбор подтверждён кодом" : "Разбор уходит человеку на проверку";
    $("#verdictText").textContent = ok
      ? `${ex.evidence.length} из ${ex.evidence.length} цитат найдены в транскрипте. Следующий шаг согласован, задача в CRM есть.`
      : reasons.join(" ");
  };
  render(false);
  verdict.classList.remove("swap");
  tamper.addEventListener("change", () => {
    render(true);
    const el = $("#tseg");
    chat.scrollTo({ top: el.offsetTop - chat.clientHeight / 2 + el.clientHeight / 2, behavior: REDUCED ? "auto" : "smooth" });
  });
  task.addEventListener("change", () => render(false));
}

initNav();
initWaves();
initConsole();
initReveal();
initManifesto();
initSteps();
initStage();
initPointer();
initDecision();
initData();
