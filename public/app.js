"use strict";
/* Демо работает без сервера: данные в demo-data.json, проверки (цитаты, маршрутизация) повторены здесь
   один в один с call_analysis.py. Сервер нужен только для живых вызовов модели. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, REDUCED ? 0 : ms));
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k, area = localStorage) { try { return JSON.parse(area.getItem(k)); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  del(k, area = localStorage) { try { area.removeItem(k); } catch { /* ignore */ } },
};

const fmt = (n) => Number(n).toLocaleString("ru-RU");
const money = (n) => `${fmt(n)} ₽`;
const mskDate = (ts, opts) => new Date(ts * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", ...opts });
const dShort = (ts) => mskDate(ts, { day: "numeric", month: "short" });
const dLong = (ts) => mskDate(ts, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many; };

const L = {
  call_type: { first_contact: "первичный", follow_up: "повторный", not_sales: "не продажи", voicemail: "автоответчик" },
  outcome: { meeting_set: "назначена встреча", callback: "договорились созвониться", thinking: "клиент думает", refused: "отказ", other: "другое" },
  asked: { asked: ["выяснено", "ok"], not_asked: ["не выяснено", "warn"], unclear: ["неясно", "mute"] },
  qual: { need: "Потребность", budget: "Бюджет", timeline: "Сроки", decision_maker: "Кто решает" },
  objection: { price: "цена", timing: "сроки", competitor: "конкуренты", trust: "доверие", need: "нет потребности", other: "другое" },
  handled: { yes: ["отработано", "ok"], partially: ["частично", "warn"], no: ["не отработано", "bad"] },
  item: { greeting_and_name: "Приветствие и имя", needs_discovery: "Выявление потребности", offer_presented: "Предложение",
    objection_handling: "Работа с возражениями", next_step_fixed: "Следующий шаг зафиксирован" },
  status: { done: ["да", "ok"], missed: ["нет", "bad"], "n/a": ["н/п", "mute"] },
  risk: { promise_without_followup: "обещание без задачи", customer_unhappy: "клиент недоволен", lost_to_competitor: "уход к конкуренту",
    manager_incorrect_info: "неверная информация", rude_or_pressure: "грубость или давление", other: "другое" },
  severity: { low: ["низкий", "mute"], medium: ["средний", "warn"], high: ["высокий", "bad"] },
  problem: { promise_without_task: "обещание без задачи", overdue_tasks: "просрочка", no_open_tasks: "нет задач" },
};
const CRM_GAP = "Добавлено кодом: договорённость есть в разговоре, задачи в CRM нет";
const ANOMALY_GAP = { open_without_tasks_pct: "12 п.п.", open_with_overdue_pct: "12 п.п.", next_step_agreed_pct: "15 п.п.", first_call_median_min: "20 мин" };

const S = {
  data: null, health: { server_key: false, model: "claude-opus-5-5" },
  key: store.get("anthropic-key", sessionStorage) || "",
  decisions: store.get("decisions-v1") || {},
  report: null, validation: null, reportSource: "cached",
  riskFilter: "all", riskAll: false, ran: false,
  sample: null, call: null,
};
const live = () => Boolean(S.key || S.health.server_key);

/* ================= boot ================= */
async function boot() {
  initTheme();
  // Запрос из консоли лендинга (?q=) и режим встраивания в лендинг (?embed=1).
  const params = new URLSearchParams(location.search);
  if (params.get("q")) $("#cmd").value = params.get("q").slice(0, 300);
  if (params.has("embed")) { document.documentElement.classList.add("embed"); $(".brand").target = "_top"; }
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#keyBtn").addEventListener("click", openKeyDialog);
  $("#keyForm").addEventListener("submit", onKeySubmit);
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  $("#runBtn").addEventListener("click", runAnalysis);
  $("#cmd").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAnalysis(); } });
  $("#checkBtn").addEventListener("click", () => checkCall());
  $("#liveBtn").addEventListener("click", liveCall);
  $("#hasTask").addEventListener("change", () => { if (S.call) checkCall(); });
  window.addEventListener("hashchange", route);

  fetch("/api/health").then((r) => r.ok ? r.json() : null).then((h) => { if (h) S.health = h; updateKeyUi(); }).catch(() => {});
  try {
    const r = await fetch("demo-data.json");
    S.data = await r.json();
  } catch {
    $("#cmdNote").textContent = "Не удалось загрузить данные демо. Обновите страницу.";
    return;
  }
  indexData();
  const d = S.data;
  $("#cmdNote").textContent = `Данные синтетические: ${d.managers.length} ${plural(d.managers.length, "менеджер", "менеджера", "менеджеров")}, ${d.leads.length} сделок, ${d.calls.length} звонков. Люди и клиенты выдуманы.`;
  S.report = d.report; S.validation = d.report_validation;
  updateKeyUi();
  renderArch();
  renderSamples();
  route();
}

function indexData() {
  const d = S.data;
  d.leadById = new Map(d.leads.map((l) => [l.id, l]));
  d.callById = new Map(d.calls.map((c) => [c.id, c]));
  d.mgrById = new Map(d.managers.map((m) => [m.id, m]));
  d.openTaskLeads = new Set(d.tasks.filter((t) => !t.is_completed).map((t) => t.lead_id));
  d.factNumbers = new Set();
  (function walk(o) {
    if (typeof o === "number") d.factNumbers.add(Math.round(o * 10) / 10);
    else if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") Object.values(o).forEach(walk);
  })(d.fact_pack);
}

/* ================= routing / theme / key ================= */
function route() {
  const view = (location.hash || "#report").slice(1).split("/")[0];
  const known = ["report", "call", "how"].includes(view) ? view : "report";
  $$(".view").forEach((v) => { v.hidden = v.id !== `view-${known}`; });
  $$(".nav a").forEach((a) => (a.dataset.view === known ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  if (known === "report" && !S.ran && S.data) runAnalysis();
  if (known === "call" && S.data) {
    const want = location.hash.split("/")[1];
    if (want && want !== S.sample) selectSample(want);
    else if (!S.sample) selectSample(S.data.samples[0].id);
  }
  window.scrollTo({ top: 0 });
}

function initTheme() {
  // По умолчанию тёмная тема, как на лендинге. Выбор посетителя запоминается.
  document.documentElement.dataset.theme = store.get("theme") || "dark";
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("theme", next);
}

function updateKeyUi() {
  $("#keyLed").classList.toggle("on", live());
  $("#keyLabel").textContent = S.key ? "Ваш ключ" : S.health.server_key ? "Живой режим" : "Ключ API";
  $("#liveBtn").title = live() ? "" : "Нужен ключ Anthropic API: кнопка «Ключ API» вверху";
}
function openKeyDialog() {
  $("#keyInput").value = S.key;
  $("#serverKeyNote").textContent = S.health.server_key
    ? `На сервере уже настроен ключ (модель ${S.health.model}), но число запросов с него ограничено.`
    : `Модель: ${S.health.model}. Серверный ключ не настроен.`;
  $("#keyDlg").showModal();
}
function onKeySubmit(e) {
  const action = e.submitter?.value;
  if (action === "save") { S.key = $("#keyInput").value.trim(); store.set("anthropic-key", S.key, sessionStorage); }
  if (action === "clear") { S.key = ""; store.del("anthropic-key", sessionStorage); }
  updateKeyUi();
}
async function api(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (S.key) headers["X-Anthropic-Key"] = S.key;
  let r;
  try { r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) }); }
  catch { throw new Error("Сервер демо недоступен. Проверьте соединение и попробуйте ещё раз."); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Ошибка сервера (${r.status})`);
  return data;
}

/* ================= analysis run (оркестрация) ================= */
async function runAnalysis() {
  if (!S.data) return;
  const cmd = $("#cmd").value.trim();
  if (!cmd) { $("#cmdNote").textContent = "Напишите запрос, например: «Проанализируй работу отдела продаж за последние 30 дней»."; return; }
  S.ran = true;
  const btn = $("#runBtn");
  btn.disabled = true; btn.classList.add("busy"); $("#runLabel").textContent = "Идёт анализ";
  $("#report").hidden = true;

  const d = S.data, fp = d.fact_pack, t = fp.team;
  const asked = cmd.match(/(\d+)\s*(дн|день|дня|дней)/i);
  const days = asked ? Number(asked[1]) : 30;
  const steps = [
    { who: "Orchestrator", src: "llm", ms: 650, msg: `Запрос разобран в структуру${days !== 30 ? `. В демо есть данные только за 30 дней, показываю их` : ""}`,
      pre: JSON.stringify({ intent: "sales_department_review", period_days: 30, scope: "отдел продаж", managers: d.managers.length }, null, 1).replace(/\n\s*/g, " ") },
    { who: "Проверка прав", src: "code", ms: 300, msg: `Роль: руководитель отдела. Доступ к данным ${d.managers.length} менеджеров разрешён, запрос записан в журнал аудита` },
    { who: "CRM Sync", src: "code", ms: 700, msg: `Снимок amoCRM на ${dLong(d.snapshot_at)} МСК: ${d.leads.length} сделок, ${d.tasks.length} задач. Изменения подтянуты инкрементально по updated_at` },
    { who: "Telephony Adapter", src: "code", ms: 600, msg: `${t.calls_total} звонков за период, ${t.calls_recorded} с записью. ${t.calls_unmatched} не связаны ни с одной сделкой` },
    { who: "STT и Call Analysis", src: "llm", ms: 700, msg: `${t.calls_analyzed} разборов взяты из кэша по ключу (транскрипт, версия промпта, модель). Новых вызовов модели: 0` },
    { who: "Sales Analytics", src: "code", ms: 650, msg: `Fact pack: ${t.leads_open} открытых сделок, ${fp.anomalies.length} отклонений от медианы, ${t.risk_deals} сделок под риском` },
    { who: "Report Agent", src: "llm", ms: 800, msg: null, report: true },
    { who: "Validator", src: "code", ms: 500, msg: null, validate: true },
    { who: "Человек в контуре", src: "human", ms: 300, msg: null, human: true },
  ];
  const trace = $("#trace");
  trace.hidden = false;
  trace.innerHTML = steps.map((s, i) => `<li data-i="${i}" class="${s.src === "human" ? "human" : ""}"><span class="t">+0,0 с</span><span class="agent">${esc(s.who)} ${srcTag(s.src)}</span><span class="msg">ожидает</span></li>`).join("");
  const t0 = performance.now();

  for (const [i, s] of steps.entries()) {
    const li = trace.children[i];
    li.classList.add("run");
    $(".msg", li).textContent = "работает…";
    if (s.report) {
      if (live()) {
        try {
          const res = await api("/api/report");
          S.report = res.report; S.validation = res.validation; S.reportSource = "live";
          s.msg = `Новый отчёт от модели ${res.usage.model}: ${S.report.insights.length} наблюдений, ${S.report.recommendations.length} рекомендаций (${fmt(res.usage.input_tokens)} → ${fmt(res.usage.output_tokens)} токенов)`;
        } catch (e) {
          S.report = d.report; S.validation = d.report_validation; S.reportSource = "cached";
          s.msg = `Живой вызов не удался (${e.message}). Показан сохранённый ответ модели`;
        }
      } else {
        await sleep(s.ms);
        S.report = d.report; S.validation = d.report_validation; S.reportSource = "cached";
        s.msg = `${S.report.insights.length} наблюдений и ${S.report.recommendations.length} рекомендаций. Сохранённый ответ модели: для нового нужен ключ API`;
      }
    } else {
      await sleep(s.ms);
    }
    if (s.validate) {
      const v = S.validation;
      s.msg = v.ok ? `Сверено ${v.numbers_checked} ${plural(v.numbers_checked, "число", "числа", "чисел")} с fact pack: расхождений нет. Ссылки на сделки и звонки существуют`
        : `Найдено расхождений: ${v.unknown_numbers.length + v.bad_refs.length}. Отчёт помечен для проверки человеком`;
    }
    if (s.human) s.msg = `${S.report.recommendations.length} ${plural(S.report.recommendations.length, "решение ждёт", "решения ждут", "решений ждут")} руководителя. В CRM ничего не изменено`;
    $(".msg", li).innerHTML = esc(s.msg) + (s.pre ? `<pre>${esc(s.pre)}</pre>` : "");
    $(".t", li).textContent = `+${((performance.now() - t0) / 1000).toFixed(1).replace(".", ",")} с`;
    li.classList.remove("run"); li.classList.add("done");
  }
  btn.disabled = false; btn.classList.remove("busy"); $("#runLabel").textContent = "Запустить ещё раз";
  renderReport();
  $("#report").hidden = false;
}

const srcTag = (src) => ({ llm: '<span class="src llm">LLM</span>', code: '<span class="src code">Код</span>', human: '<span class="src human">Человек</span>', ml: '<span class="src ml">ML</span>' }[src]);

/* ================= report ================= */
function renderReport() {
  const d = S.data, fp = d.fact_pack, t = fp.team;
  $("#reportSub").textContent = `${dShort(fp.period.from)} — ${dShort(fp.period.to)} 2026, ${d.managers.length} менеджера. Снимок данных на ${dLong(fp.snapshot_at)} МСК.`;
  const v = S.validation;
  $("#verifyBadge").className = `verify ${v.ok ? "" : "bad"}`;
  $("#verifyBadge").innerHTML = `<span class="ok-dot">${v.ok ? "✓" : "!"}</span><span><b>${v.ok ? "Отчёт проверен кодом" : "Есть расхождения"}</b><br>${v.numbers_checked} ${plural(v.numbers_checked, "число", "числа", "чисел")} сверено с fact pack${S.reportSource === "live" ? ", отчёт написан моделью только что" : ""}</span>`;

  const kpis = [
    { v: t.leads_open, l: "Открытых сделок", d: `${t.leads_new} новых за период` },
    { v: t.open_without_tasks, small: `${t.open_without_tasks_pct}%`, l: "Без открытых задач", d: "никто не запланировал следующий шаг", cls: "alert", filter: "no_open_tasks" },
    { v: t.open_with_overdue, small: `${t.open_with_overdue_pct}%`, l: "С просроченными задачами", d: `самая старая — ${t.overdue_max_days} ${plural(t.overdue_max_days, "день", "дня", "дней")}`, cls: "alert", filter: "overdue_tasks" },
    { v: t.promise_without_task, l: "Обещано, но нет задачи", d: "договорённость в звонке, задачи в CRM нет", cls: "amber", filter: "promise_without_task" },
    { v: t.closed, l: "Закрыто за период", d: `${t.won} выиграно на ${money(t.revenue_won)}, ${t.lost} проиграно` },
    { v: t.calls_analyzed, small: `из ${t.calls_total}`, l: "Звонков разобрано", d: `покрытие ${t.analysis_coverage_pct}%, без сделки ${t.calls_unmatched}` },
  ];
  $("#kpis").innerHTML = kpis.map((k, i) => `<button class="kpi ${k.cls || ""}" type="button" data-i="${i}" ${k.filter ? `data-filter="${k.filter}"` : ""}>
    <span class="v">${fmt(k.v)}${k.small ? `<small>${esc(k.small)}</small>` : ""}</span><span class="l">${esc(k.l)}</span><span class="d">${esc(k.d)}</span></button>`).join("");
  $$("#kpis .kpi").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.filter) { S.riskFilter = b.dataset.filter; renderRisk(); $("#riskTitle").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }); }
    else if (b.dataset.i === "5") location.hash = "#call";
    else $("#mgrTitle").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  }));

  renderInsights(); renderDecisions(); renderManagers(); renderRisk();
  $("#gaps").innerHTML = [
    ...fp.not_available.map((x) => `<li>${esc(x)}. Без этих данных выполнение плана и прибыльность не оцениваются.</li>`),
    `<li>Звонки с личных телефонов менеджеров в телефонию не попадают. Покрытие разбором — ${t.analysis_coverage_pct}% звонков за период.</li>`,
    `<li>Конверсия по менеджерам показана, но за период закрыто всего ${t.closed} сделок: для выводов о людях этого мало.</li>`,
  ].join("");
}

function numberize(text) {
  const re = /(?<![\w.])(\d{1,3}(?:[   ]\d{3})+|\d+(?:[.,]\d+)?)(?![\w])/g;
  return esc(text).replace(re, (m) => {
    const n = Math.round(Number(m.replace(/[   ]/g, "").replace(",", ".")) * 10) / 10;
    const ok = S.data.factNumbers.has(n);
    return `<span class="num ${ok ? "" : "bad"}" title="${ok ? "Число есть в fact pack" : "Числа нет в fact pack"}">${m}</span>`;
  });
}

function refChips(ids) {
  const d = S.data;
  return ids.length ? `<div class="refs">${ids.map((id) => {
    if (d.callById.has(id)) return `<button class="ref" data-call="${id}" type="button"><svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>звонок ${id}</button>`;
    if (d.leadById.has(id)) return `<button class="ref" data-lead="${id}" type="button"><svg viewBox="0 0 24 24"><path d="M4 7h16v12H4zM9 7V5h6v2"/></svg>${esc(d.leadById.get(id).name)}</button>`;
    return `<span class="ref">#${id} не найден</span>`;
  }).join("")}</div>` : "";
}
function bindRefs(root) {
  $$("[data-call]", root).forEach((b) => b.addEventListener("click", () => openCall(Number(b.dataset.call))));
  $$("[data-lead]", root).forEach((b) => b.addEventListener("click", () => openLead(Number(b.dataset.lead))));
}

function renderInsights() {
  const d = S.data;
  $("#insights").innerHTML = S.report.insights.map((i) => `<li><span class="sev ${i.severity}"></span><div>
    <div class="who">${esc(i.manager_id ? d.mgrById.get(i.manager_id)?.name || "Менеджер" : "Отдел целиком")}</div>
    <p>${numberize(i.text)}</p>${refChips(i.evidence)}</div></li>`).join("");
  bindRefs($("#insights"));
}

function renderDecisions() {
  const recs = S.report.recommendations;
  const done = recs.filter((r) => S.decisions[decKey(r)]).length;
  $("#decLead").textContent = `Решено ${done} из ${recs.length}. Система предлагает, но ничего не меняет в CRM и не делает выводов о людях.`;
  const label = { yes: "Утверждено: задача уйдёт ответственному", no: "Отклонено", later: "Отложено" };
  $("#decisions").innerHTML = recs.map((r) => {
    const st = S.decisions[decKey(r)];
    return `<li class="decision ${st ? "done" : ""}" data-k="${esc(decKey(r))}">
      <div class="owner">${esc(r.owner)}${r.manager_id ? `, ${esc(S.data.mgrById.get(r.manager_id)?.name || "")}` : ""}</div>
      <p>${numberize(r.text)}</p>${refChips(r.evidence)}
      <div class="acts" style="margin-top:10px">${st ? `<span class="state ${st}">${label[st]}</span><button class="linkbtn" data-act="undo" type="button">Отменить</button>`
        : `<button class="chipbtn yes" data-act="yes" type="button">Утвердить</button><button class="chipbtn" data-act="later" type="button">Отложить</button><button class="chipbtn" data-act="no" type="button">Отклонить</button>`}</div></li>`;
  }).join("");
  $$("#decisions [data-act]").forEach((b) => b.addEventListener("click", () => {
    const k = b.closest(".decision").dataset.k;
    if (b.dataset.act === "undo") delete S.decisions[k]; else S.decisions[k] = b.dataset.act;
    store.set("decisions-v1", S.decisions);
    renderDecisions();
  }));
  bindRefs($("#decisions"));
}
const decKey = (r) => `${S.reportSource}:${r.id}:${r.text.slice(0, 40)}`;

function renderManagers() {
  const d = S.data, fp = d.fact_pack;
  const flag = (mid, metric) => fp.anomalies.find((a) => a.manager_id === mid && a.metric === metric);
  const cell = (mid, m, metric, val, sub, max, unit = "%") => {
    if (val === null || val === undefined) return `<td class="n"><span class="cell"><span>—</span></span></td>`;
    const a = mid && flag(mid, metric);
    const tip = a ? `Медиана остальных: ${a.others_median}${unit === "%" ? "%" : " мин"}. Правило: отклонение не меньше ${ANOMALY_GAP[metric]}` : "";
    return `<td class="n"><span class="cell ${a ? "flag" : ""}" ${tip ? `title="${esc(tip)}"` : ""}><span>${fmt(val)}${unit}${a ? " ⚑" : ""}</span><span class="bar"><i style="width:${Math.min(100, (val / max) * 100)}%"></i></span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</span></td>`;
  };
  const row = (name, mid, m, cls = "") => `<tr class="${cls}"><td>${esc(name)}</td><td class="n">${m.leads_open}</td>
    ${cell(mid, m, "open_without_tasks_pct", m.open_without_tasks_pct, `${m.open_without_tasks} сделок`, 100)}
    ${cell(mid, m, "open_with_overdue_pct", m.open_with_overdue_pct, `${m.open_with_overdue} сделок`, 100)}
    <td class="n">${m.promise_without_task}</td>
    ${cell(mid, m, "next_step_agreed_pct", m.next_step_agreed_pct, `${m.next_step_agreed} из ${m.calls_sales}`, 100)}
    ${cell(mid, m, "first_call_median_min", m.first_call_median_min, "медиана", 60, " мин")}
    <td class="n">${m.won} из ${m.closed}</td><td class="n">${money(m.revenue_won)}</td></tr>`;
  $("#mgrTable").innerHTML = `<thead><tr><th>Менеджер</th><th class="n">Открыто</th><th class="n">Без задач</th><th class="n">Просрочка</th><th class="n">Обещано без задачи</th><th class="n">Шаг согласован</th><th class="n">Первый звонок</th><th class="n">Выиграно</th><th class="n">Выручка</th></tr></thead>
    <tbody>${d.managers.map((m) => row(m.name, m.id, fp.managers[m.id])).join("")}${row("Весь отдел", null, fp.team, "team-row")}</tbody>`;
}

function renderRisk() {
  const d = S.data, all = d.fact_pack.risk_deals;
  const counts = { all: all.length };
  for (const p of Object.keys(L.problem)) counts[p] = all.filter((r) => r.problems.includes(p)).length;
  const names = { all: "Все", ...L.problem };
  $("#riskFilters").innerHTML = Object.keys(names).map((k) => `<button class="filter" role="tab" type="button" data-f="${k}" aria-selected="${S.riskFilter === k}">${esc(names[k])} ${counts[k]}</button>`).join("");
  $$("#riskFilters .filter").forEach((b) => b.addEventListener("click", () => { S.riskFilter = b.dataset.f; S.riskAll = false; renderRisk(); }));
  const rows = all.filter((r) => S.riskFilter === "all" || r.problems.includes(S.riskFilter));
  const shown = S.riskAll ? rows : rows.slice(0, 10);
  $("#riskTable").innerHTML = `<thead><tr><th>Сделка</th><th>Менеджер</th><th>Стадия</th><th class="n">Сумма</th><th>Что не так</th><th class="n">Просрочка</th><th>Доказательство</th></tr></thead>
    <tbody>${shown.map((r) => { const l = d.leadById.get(r.lead_id); return `<tr>
      <td><button class="linkbtn lead-name" data-lead="${l.id}" type="button">${esc(l.name)}</button><div class="lead-id">#${l.id}</div></td>
      <td>${esc(d.mgrById.get(r.manager_id).name)}</td><td>${esc(d.statuses[l.status_id])}</td><td class="n">${money(r.price)}</td>
      <td>${r.problems.map((p) => `<span class="prob ${p}">${esc(L.problem[p])}</span>`).join("")}</td>
      <td class="n">${r.overdue_days ? `${r.overdue_days} дн.` : "—"}</td>
      <td>${r.evidence_call_id ? `<button class="linkbtn" data-call="${r.evidence_call_id}" type="button">звонок ${dShort(d.callById.get(r.evidence_call_id).started_at)}</button>` : "—"}</td></tr>`; }).join("")}
    ${rows.length > shown.length ? `<tr><td colspan="7"><button class="linkbtn" id="riskMore" type="button">Показать все ${rows.length}</button></td></tr>` : ""}</tbody>`;
  $("#riskMore")?.addEventListener("click", () => { S.riskAll = true; renderRisk(); });
  bindRefs($("#riskTable"));
}

/* ================= drawer: сделка и звонок ================= */
function openDrawer(title, html) {
  $("#drawerTitle").textContent = title;
  $("#drawerBody").innerHTML = html;
  $("#scrim").hidden = false; $("#drawer").hidden = false;
  bindRefs($("#drawerBody"));
  $("#drawerClose").focus();
}
function closeDrawer() { $("#scrim").hidden = true; $("#drawer").hidden = true; }

function openLead(id) {
  const d = S.data, l = d.leadById.get(id);
  const tasks = d.tasks.filter((t) => t.lead_id === id).sort((a, b) => b.complete_till - a.complete_till);
  const calls = d.calls.filter((c) => c.lead_id === id).sort((a, b) => b.started_at - a.started_at);
  const now = d.snapshot_at;
  openDrawer(l.name, `
    <div class="panel"><dl class="kv"><dt>Сделка</dt><dd>#${l.id}</dd><dt>Менеджер</dt><dd>${esc(d.mgrById.get(l.manager_id).name)}</dd>
      <dt>Стадия</dt><dd>${esc(d.statuses[l.status_id])}</dd><dt>Сумма</dt><dd>${money(l.price)}</dd>
      <dt>Создана</dt><dd>${dLong(l.created_at)}</dd>${l.closed_at ? `<dt>Закрыта</dt><dd>${dLong(l.closed_at)}</dd>` : ""}</dl></div>
    <div class="panel"><div class="panel-hd"><h3>Задачи в amoCRM</h3>${srcTag("code")}</div>
      ${tasks.length ? `<ul class="list">${tasks.map((t) => `<li>${t.is_completed ? '<span class="pill mute">выполнена</span>' : t.complete_till < now ? '<span class="pill bad">просрочена</span>' : '<span class="pill ok">открыта</span>'} срок ${dLong(t.complete_till)}</li>`).join("")}</ul>` : "<p>Задач нет.</p>"}
      ${l.closed_at ? "" : d.openTaskLeads.has(id) ? "" : '<p class="hint">Открытых задач нет: следующий шаг по сделке никто не запланировал.</p>'}</div>
    <div class="panel"><div class="panel-hd"><h3>Звонки</h3></div>
      ${calls.length ? `<ul class="list">${calls.map((c) => `<li><button class="linkbtn" data-call="${c.id}" type="button">${dLong(c.started_at)}</button> ${mmss(c.duration_sec)} ${c.analysis?.analyzable ? (c.analysis.next_step_agreed ? '<span class="pill ok">шаг согласован</span>' : '<span class="pill warn">шаг не согласован</span>') : '<span class="pill mute">не разбирался</span>'}</li>`).join("")}</ul>` : "<p>Звонков нет.</p>"}</div>`);
}

function openCall(id) {
  const d = S.data, c = d.callById.get(id), a = c.analysis, l = c.lead_id ? d.leadById.get(c.lead_id) : null;
  const hasTask = l ? d.openTaskLeads.has(l.id) : null;
  openDrawer(`Звонок ${id}`, `
    <div class="panel"><dl class="kv"><dt>Менеджер</dt><dd>${esc(d.mgrById.get(c.manager_id).name)}</dd>
      <dt>Сделка</dt><dd>${l ? `<button class="linkbtn" data-lead="${l.id}" type="button">${esc(l.name)}</button>` : "не связан со сделкой"}</dd>
      <dt>Когда</dt><dd>${dLong(c.started_at)} МСК</dd><dt>Длительность</dt><dd>${mmss(c.duration_sec)}</dd>
      <dt>Направление</dt><dd>${c.direction === "out" ? "исходящий" : "входящий"}</dd><dt>Запись</dt><dd>${c.has_recording ? "есть" : "нет"}</dd></dl></div>
    ${a ? `<div class="panel"><div class="panel-hd"><h3>Разбор</h3>${srcTag("llm")}</div><dl class="kv">
      <dt>Тип</dt><dd>${esc(L.call_type[a.call_type])}</dd>
      ${a.analyzable ? `<dt>Следующий шаг</dt><dd>${a.next_step_agreed ? '<span class="pill ok">согласован</span>' : '<span class="pill warn">не согласован</span>'}</dd>
      <dt>Возражения</dt><dd>${a.objections.length ? a.objections.map((o) => esc(L.objection[o])).join(", ") : "нет"}</dd>
      <dt>Пропущено по скрипту</dt><dd>${a.checklist_missed.length ? a.checklist_missed.map((x) => esc(L.item[x])).join(", ") : "ничего"}</dd>
      <dt>Уверенность</dt><dd>${a.confidence !== null ? `${Math.round(a.confidence * 100)}%` : "—"}</dd>` : "<dt>Итог</dt><dd>не анализируется, в метрики не входит</dd>"}</dl></div>
    ${l && a.analyzable ? `<div class="panel"><div class="panel-hd"><h3>Сверка с CRM</h3>${srcTag("code")}</div><p style="margin:0">${a.next_step_agreed && !hasTask ? '<span class="pill bad">обещание без задачи</span> В разговоре договорились о следующем шаге, а открытой задачи по сделке нет.' : hasTask ? '<span class="pill ok">задача есть</span> Следующий шаг запланирован в CRM.' : '<span class="pill mute">задачи нет</span> Шаг в разговоре не согласован.'}</p></div>` : ""}` : `<div class="panel"><p style="margin:0">${c.has_recording ? "Звонок не связан со сделкой, поэтому не разбирался. Его стоит проверить вручную." : "Записи нет, разбирать нечего."}</p></div>`}
    ${c.sample_id ? `<button class="btn primary" type="button" id="toSample">Открыть полный разбор с транскриптом</button>` : `<p class="hint">Полный транскрипт в демо есть у трёх звонков. Для остальных показан сохранённый результат разбора.</p>`}`);
  $("#toSample")?.addEventListener("click", () => { closeDrawer(); location.hash = `#call/${c.sample_id}`; });
}

/* ================= разбор звонка ================= */
function renderSamples() {
  const items = [...S.data.samples.map((s) => ({ id: s.id, title: s.title, desc: s.description })), { id: "own", title: "Свой звонок", desc: "Вставьте транскрипт, модель разберёт его. Нужен ключ API" }];
  $("#sampleList").innerHTML = items.map((s) => `<button class="sample" role="tab" type="button" data-s="${s.id}" aria-selected="false"><b>${esc(s.title)}</b><span>${esc(s.desc)}</span></button>`).join("");
  $$("#sampleList .sample").forEach((b) => b.addEventListener("click", () => { location.hash = `#call/${b.dataset.s}`; }));
}

function selectSample(id) {
  S.sample = id;
  $$("#sampleList .sample").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.s === id)));
  $("#callErr").hidden = true;
  const s = S.data.samples.find((x) => x.id === id);
  if (s) {
    $("#transcript").value = s.transcript;
    $("#hasTask").checked = s.lead_has_open_task;
    $("#editor").open = false;
    $("#checkBtn").disabled = false;
    checkCall();
  } else {
    S.call = null;
    $("#transcript").value = "[00:00] Менеджер: Добрый день, это автосалон.\n[00:04] Клиент: ";
    $("#hasTask").checked = false;
    $("#editor").open = true;
    $("#checkBtn").disabled = true;
    $("#callMain").innerHTML = `<div class="empty">${live() ? "Вставьте транскрипт слева и нажмите «Разобрать моделью»." : "Для своего звонка нужен ключ Anthropic API: нажмите «Ключ API» вверху. Три готовых звонка слева работают без ключа."}</div>`;
  }
}

/* Порт call_analysis.py: те же правила, что на сервере */
const LINE = /^\s*(?:\[(\d{1,2}):(\d{2})(?::(\d{2}))?\])?\s*([^:]{1,20}):\s*(.+?)\s*$/;
const SPEAKERS = { "менеджер": "manager", manager: "manager", "м": "manager", "оператор": "manager", "клиент": "customer", customer: "customer", "к": "customer", "покупатель": "customer" };
function parseTranscript(text) {
  const segs = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(LINE);
    const speaker = m && SPEAKERS[m[4].trim().toLowerCase()];
    if (!m || !speaker) { if (raw.trim() && segs.length) segs[segs.length - 1].text += " " + raw.trim(); continue; }
    const start = m[1] !== undefined ? (m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]) : (segs.length ? segs[segs.length - 1].start + 5 : 0);
    segs.push({ speaker, start, end: start, text: m[5] });
  }
  segs.forEach((s, i) => { const nxt = i + 1 < segs.length ? segs[i + 1].start : s.start + 5; s.end = Math.max(s.start, nxt); });
  return segs;
}
const norm = (t) => t.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}_\s]/gu, " ").replace(/\s+/g, " ").trim();
function unverified(ex, segs, win = 10) {
  return ex.evidence.filter((ev) => {
    const q = norm(ev.quote);
    return !(q && segs.some((s) => s.speaker === ev.speaker && s.start - win <= ev.start_sec && ev.start_sec <= s.end + win && norm(s.text).includes(q)));
  }).map((ev) => ev.id);
}
function route_(ex, segs, hasTask) {
  const reasons = [], bad = unverified(ex, segs);
  if (bad.length) reasons.push(`цитаты не найдены в транскрипте: ${bad.join(", ")}`);
  if ([ex.customer_intent, ex.outcome].some((c) => c && c.confidence < 0.6)) reasons.push("низкая уверенность модели");
  if (ex.risks.some((r) => r.severity === "high")) reasons.push("риск высокой серьёзности");
  const risks = ex.risks.filter((r) => r.description !== CRM_GAP);
  if (ex.analyzable && ex.next_step.agreed && !hasTask) {
    risks.push({ type: "promise_without_followup", severity: "high", description: CRM_GAP, evidence: ex.next_step.evidence });
    reasons.push("следующий шаг согласован, а открытой задачи в CRM нет");
  }
  return { ...ex, risks, unverified_evidence: bad, needs_review: reasons.length > 0, review_reasons: reasons };
}

function checkCall() {
  const s = S.data.samples.find((x) => x.id === S.sample);
  if (!s && !S.call) return;
  const segs = parseTranscript($("#transcript").value);
  if (!segs.length) return showCallErr("Не нашёл реплик. Формат строки: «[00:12] Менеджер: текст».");
  const ex = s ? s.extraction : S.call.raw;
  S.call = { segs, raw: ex, a: route_(ex, segs, $("#hasTask").checked), source: s ? "cached" : S.call.source, model: s ? "сохранённый ответ модели" : S.call.model, usage: s ? null : S.call.usage };
  $("#callErr").hidden = true;
  renderCall();
}

async function liveCall() {
  if (!live()) return openKeyDialog();
  const btn = $("#liveBtn");
  btn.disabled = true; btn.classList.add("busy"); btn.textContent = "Модель разбирает";
  try {
    const res = await api("/api/analyze", { transcript: $("#transcript").value, mode: "live", lead_has_open_task: $("#hasTask").checked });
    const raw = { ...res.analysis }; delete raw.unverified_evidence; delete raw.needs_review; delete raw.review_reasons;
    raw.risks = raw.risks.filter((r) => r.description !== CRM_GAP);
    S.call = { segs: res.segments, raw, a: res.analysis, source: "live", model: res.model, usage: res.usage };
    $("#checkBtn").disabled = false;
    $("#callErr").hidden = true;
    renderCall();
  } catch (e) { showCallErr(e.message); }
  finally { btn.disabled = false; btn.classList.remove("busy"); btn.textContent = "Разобрать моделью"; }
}
function showCallErr(msg) { $("#callErr").textContent = msg; $("#callErr").hidden = false; }

function renderCall() {
  const { segs, a } = S.call, bad = new Set(a.unverified_evidence);
  const chips = (ids) => ids?.length ? `<span class="evc">${ids.map((id) => `<button type="button" class="${bad.has(id) ? "bad" : ""}" data-ev="${esc(id)}" title="Показать цитату">${esc(id)}</button>`).join("")}</span>` : "";
  const pill = ([t, k]) => `<span class="pill ${k}">${esc(t)}</span>`;
  const conf = (c) => `<span class="conf"><span class="b"><i style="width:${Math.round(c * 100)}%"></i></span>${Math.round(c * 100)}%</span>`;

  let verdict;
  if (!a.analyzable) verdict = `<div class="verdict skip"><span class="ico">–</span><div><h2>Не анализируется: ${esc(a.skip_reason || "разговора нет")}</h2><p>Такие звонки отсекаются до выводов и не попадают в метрики менеджера.</p></div>${srcTag("code")}</div>`;
  else if (a.needs_review) verdict = `<div class="verdict warn"><span class="ico">!</span><div><h2>Нужна проверка человеком</h2><ul>${a.review_reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>${srcTag("code")}</div>`;
  else verdict = `<div class="verdict ok"><span class="ico">✓</span><div><h2>Можно в отчёт без ревью</h2><p>Все цитаты найдены в транскрипте, договорённость отражена в CRM, серьёзных рисков нет.</p></div>${srcTag("code")}</div>`;

  const total = Math.max(1, segs[segs.length - 1].end);
  const timeline = `<div class="timeline"><div class="timeline-hd"><span><b>${mmss(total)}</b> разговора, ${segs.length} ${plural(segs.length, "реплика", "реплики", "реплик")}, ${a.evidence.length} ${plural(a.evidence.length, "цитата", "цитаты", "цитат")}</span>
    <span class="legend"><span><i style="background:var(--mgr)"></i>менеджер</span><span><i style="background:var(--cus)"></i>клиент</span><span><i style="background:var(--ok);border-radius:50%"></i>цитата найдена</span><span><i style="background:var(--bad);border-radius:50%"></i>не найдена</span></span></div>
    <div class="track-wrap">${a.evidence.map((e) => `<button type="button" class="pin ${bad.has(e.id) ? "bad" : ""}" style="left:${Math.min(99, (e.start_sec / total) * 100)}%" data-ev="${esc(e.id)}" title="${esc(e.id)}: «${esc(e.quote)}»" aria-label="Цитата ${esc(e.id)}"></button>`).join("")}
    <div class="track">${segs.map((s, i) => `<span class="s ${s.speaker}" data-seg="${i}" style="flex:${Math.max(1, s.end - s.start)}" title="${mmss(s.start)} ${s.speaker === "manager" ? "Менеджер" : "Клиент"}: ${esc(s.text)}"></span>`).join("")}</div></div>
    <div class="ticks"><span>00:00</span><span>${mmss(total / 2)}</span><span>${mmss(total)}</span></div></div>`;

  const marksFor = (i) => a.evidence.filter((e) => bestSeg(e) === i);
  const chat = `<div class="panel"><div class="panel-hd"><h3>Транскрипт</h3>${srcTag("ml")}</div><div class="chat">${segs.map((s, i) => `<div class="bubble ${s.speaker}" data-seg="${i}"><span class="meta">${s.speaker === "manager" ? "Менеджер" : "Клиент"}, ${mmss(s.start)}</span>${markText(s.text, marksFor(i), bad)}</div>`).join("")}</div></div>`;

  const ns = a.next_step, q = a.qualification;
  const checklist = a.script_checklist || [], done = checklist.filter((c) => c.status === "done").length, applicable = checklist.filter((c) => c.status !== "n/a").length;
  const facts = `<div class="panel"><div class="panel-hd"><h3>Разбор</h3>${srcTag("llm")}</div><div class="facts">
    <div class="fact"><div class="body">${esc(a.summary)}</div></div>
    <div class="fact"><dl class="kv"><dt>Тип звонка</dt><dd>${esc(L.call_type[a.call_type])}</dd>
      ${a.outcome ? `<dt>Итог</dt><dd>${esc(L.outcome[a.outcome.value] || a.outcome.value)}${conf(a.outcome.confidence)}${chips(a.outcome.evidence)}</dd>` : ""}
      ${a.customer_intent ? `<dt>Клиент хочет</dt><dd>${esc(a.customer_intent.value)}${conf(a.customer_intent.confidence)}${chips(a.customer_intent.evidence)}</dd>` : ""}</dl></div>
    ${a.analyzable ? `<div class="fact"><h4>Следующий шаг</h4><dl class="kv"><dt>Согласован</dt><dd>${ns.agreed ? pill(["да", "ok"]) : pill(["нет", "warn"])}${chips(ns.evidence)}</dd>
      ${ns.what ? `<dt>Что</dt><dd>${esc(ns.what)}</dd>` : ""}${ns.when_mentioned ? `<dt>Когда</dt><dd>«${esc(ns.when_mentioned)}»</dd>` : ""}
      <dt>Задача в CRM</dt><dd>${$("#hasTask").checked ? pill(["есть", "ok"]) : pill(["нет", ns.agreed ? "bad" : "mute"])} ${srcTag("code")}</dd></dl></div>` : ""}
    ${q ? `<div class="fact"><h4>Квалификация</h4><div class="qual">${Object.entries(L.qual).map(([k, t]) => `<div><span>${t}</span>${pill(L.asked[q[k]])}</div>`).join("")}</div></div>` : ""}
    ${a.objections.length ? `<div class="fact"><h4>Возражения</h4><ul class="list">${a.objections.map((o) => `<li><b>${esc(L.objection[o.type])}</b>${pill(L.handled[o.handled])}${chips(o.evidence)}</li>`).join("")}</ul></div>` : ""}
    ${checklist.length ? `<div class="fact"><h4>Чек-лист скрипта</h4><div class="checklist">${ring(done, applicable)}<ul class="list">${checklist.map((c) => `<li>${pill(L.status[c.status])}<span>${esc(L.item[c.item] || c.item)}</span>${chips(c.evidence)}</li>`).join("")}</ul></div></div>` : ""}
    ${a.risks.length ? `<div class="fact"><h4>Риски</h4><ul class="list">${a.risks.map((r) => `<li>${pill(L.severity[r.severity])}<b>${esc(L.risk[r.type])}</b>${r.description === CRM_GAP ? srcTag("code") : ""}<span style="color:var(--mute)">${esc(r.description === CRM_GAP ? "договорённость есть, задачи в CRM нет" : r.description)}</span>${chips(r.evidence)}</li>`).join("")}</ul></div>` : ""}
  </div>
  <details class="raw"><summary>JSON результата (CallAnalysis)</summary><pre>${jsonHtml({ ...a, model: S.call.model })}</pre></details></div>`;

  $("#callMain").innerHTML = `${verdict}${timeline}<div class="call-grid">${chat}${facts}</div>
    <p class="hint">${S.call.source === "live" ? `Живой разбор: ${esc(S.call.model)}${S.call.usage ? `, ${fmt(S.call.usage.input_tokens)} → ${fmt(S.call.usage.output_tokens)} токенов` : ""}.` : "Сохранённый ответ модели. Проверки кода выполнены сейчас, в вашем браузере."} Измените транскрипт или переключатель задачи в CRM и нажмите «Проверить».</p>`;
  $$("#callMain [data-ev]").forEach((b) => b.addEventListener("click", () => showEvidence(b.dataset.ev)));
  $$("#callMain .track .s").forEach((b) => b.addEventListener("click", () => flashSeg(Number(b.dataset.seg))));
}

function ring(done, total) {
  const r = 26, c = 2 * Math.PI * r, p = total ? done / total : 0;
  return `<svg class="ring" viewBox="0 0 64 64" role="img" aria-label="${done} из ${total}"><circle class="bg" cx="32" cy="32" r="${r}"/><circle class="fg" cx="32" cy="32" r="${r}" stroke-dasharray="${c * p} ${c}"/><text x="32" y="33">${done}/${total}</text></svg>`;
}

function bestSeg(e) {
  const segs = S.call.segs; let best = -1, dist = Infinity;
  segs.forEach((s, i) => {
    if (s.speaker !== e.speaker) return;
    const contains = norm(s.text).includes(norm(e.quote));
    const d = (e.start_sec < s.start ? s.start - e.start_sec : Math.max(0, e.start_sec - s.end)) - (contains ? 1000 : 0);
    if (d < dist) { dist = d; best = i; }
  });
  return best;
}
function findRange(text, quote) {
  const words = quote.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  if (!words.length) return null;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}_]+"), "iu");
  const m = text.toLowerCase().replace(/ё/g, "е").match(re);
  return m ? [m.index, m.index + m[0].length] : null;
}
function markText(text, evs, bad) {
  const ranges = evs.map((e) => { const r = findRange(text, e.quote); return r && { s: r[0], e: r[1], id: e.id }; }).filter(Boolean).sort((x, y) => x.s - y.s);
  let out = "", pos = 0;
  for (const r of ranges) {
    if (r.s < pos) continue;
    out += esc(text.slice(pos, r.s)) + `<mark data-ev="${esc(r.id)}" class="${bad.has(r.id) ? "bad" : ""}" title="${esc(r.id)}">${esc(text.slice(r.s, r.e))}</mark>`;
    pos = r.e;
  }
  return out + esc(text.slice(pos));
}
function showEvidence(id) {
  const e = S.call.a.evidence.find((x) => x.id === id);
  if (!e) return;
  const i = bestSeg(e);
  if (i < 0) return;
  flashSeg(i);
  if (S.call.a.unverified_evidence.includes(id)) showCallErr(`Цитата ${id} «${e.quote}» не найдена в транскрипте у этого спикера рядом с ${mmss(e.start_sec)}. Поэтому разбор уходит на проверку человеку.`);
}
function flashSeg(i) {
  $$("#callMain .hl").forEach((x) => x.classList.remove("hl"));
  const b = $(`#callMain .bubble[data-seg="${i}"]`), s = $(`#callMain .track .s[data-seg="${i}"]`);
  b?.classList.add("hl"); s?.classList.add("hl");
  b?.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "nearest" });
}
function jsonHtml(o) {
  return esc(JSON.stringify(o, null, 2)).replace(/(&quot;[^&]*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g, (m, s, colon, b, n) =>
    s ? `<span class="${colon ? "j-k" : "j-s"}">${s}</span>${colon || ""}` : b ? `<span class="j-b">${b}</span>` : `<span class="j-n">${n}</span>`);
}

/* ================= архитектура ================= */
function renderArch() {
  const node = (t, s, cls) => `<span class="node ${cls}">${esc(t)}<small>${esc(s)}</small></span>`;
  const ar = '<span class="arrow" aria-hidden="true">→</span>';
  $("#arch").innerHTML = `
    <div class="arch-row"><b>Запрос</b><div class="flow">${node("Руководитель", "Telegram или веб", "human")}${ar}${node("API", "авторизация, права, аудит", "code")}${ar}${node("Orchestrator", "фраза → структура запроса", "llm")}</div></div>
    <div class="arch-row"><b>Данные, непрерывно</b><div class="flow">${node("amoCRM API v4", "сделки, задачи, события", "store")}${ar}${node("CRM Sync", "webhooks, 7 запросов/с, upsert", "code")}${ar}${node("PostgreSQL", "сырые данные и нормализованные", "store")}</div></div>
    <div class="arch-row"><b>Звонки, непрерывно</b><div class="flow">${node("Телефония", "через адаптер провайдера", "store")}${ar}${node("Call Ingest", "запись → S3, связь со сделкой", "code")}${ar}${node("STT", "речь в текст, спикеры", "")}${ar}${node("Call Analysis", "JSON по схеме + цитаты", "llm")}${ar}${node("Проверка цитат", "дословно, тот же спикер", "code")}</div></div>
    <div class="arch-row"><b>Отчёт по запросу</b><div class="flow">${node("Sales Analytics", "метрики и аномалии", "code")}${ar}${node("Report Agent", "текст только из fact pack", "llm")}${ar}${node("Validator", "числа и ссылки", "code")}${ar}${node("Руководитель", "утверждает решения", "human")}</div></div>`;
}

boot();
