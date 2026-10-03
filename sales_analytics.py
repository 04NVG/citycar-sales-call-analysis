"""Sales Analytics: детерминированные метрики отдела по данным CRM и телефонии. LLM здесь не участвует.

Вход — нормализованный датасет (как после CRM Sync и Call Ingest), выход — fact pack: все числа отчёта.
Report Agent пишет текст только из fact pack, а report_validator проверяет, что чисел «из головы» нет.
"""
from collections import Counter
from statistics import median

WON, LOST = 142, 143
DAY = 86400


def _pct(part: int, total: int) -> int | None:
    return round(100 * part / total) if total else None


def _manager_slice(ds: dict, manager_id: int | None, now: int, period_from: int) -> dict:
    leads = [l for l in ds["leads"] if manager_id is None or l["manager_id"] == manager_id]
    lead_ids = {l["id"] for l in leads}
    open_leads = [l for l in leads if l["status_id"] not in (WON, LOST)]
    closed = [l for l in leads if l["closed_at"] and l["closed_at"] >= period_from]
    won = [l for l in closed if l["status_id"] == WON]
    lost = [l for l in closed if l["status_id"] == LOST]

    open_tasks: dict[int, list[int]] = {}
    for t in ds["tasks"]:
        if not t["is_completed"] and t["lead_id"] in lead_ids:
            open_tasks.setdefault(t["lead_id"], []).append(t["complete_till"])
    no_tasks = [l for l in open_leads if l["id"] not in open_tasks]
    overdue = [l for l in open_leads if any(d < now for d in open_tasks.get(l["id"], []))]
    overdue_days = [(now - min(open_tasks[l["id"]])) / DAY for l in overdue]

    calls = [c for c in ds["calls"] if c["started_at"] >= period_from
             and (manager_id is None or c["manager_id"] == manager_id)]
    recorded = [c for c in calls if c["has_recording"]]
    analyzed = [c for c in recorded if c["analysis"] is not None]
    sales = [c for c in analyzed if c["analysis"]["analyzable"] and c["analysis"]["call_type"] != "not_sales"]
    agreed = [c for c in sales if c["analysis"]["next_step_agreed"]]
    objections = Counter(o for c in sales for o in c["analysis"]["objections"])

    first_call_min = []
    for l in leads:
        if l["created_at"] < period_from:
            continue
        outs = [c["started_at"] for c in ds["calls"] if c["lead_id"] == l["id"] and c["direction"] == "out"]
        if outs:
            first_call_min.append((min(outs) - l["created_at"]) / 60)

    return {
        "leads_open": len(open_leads),
        "leads_new": sum(1 for l in leads if l["created_at"] >= period_from),
        "closed": len(won) + len(lost), "won": len(won), "lost": len(lost), "win_rate_pct": _pct(len(won), len(won) + len(lost)),
        "revenue_won": sum(l["price"] for l in won),
        "open_without_tasks": len(no_tasks), "open_without_tasks_pct": _pct(len(no_tasks), len(open_leads)),
        "open_with_overdue": len(overdue), "open_with_overdue_pct": _pct(len(overdue), len(open_leads)),
        "overdue_max_days": round(max(overdue_days)) if overdue_days else 0,
        "calls_total": len(calls), "calls_recorded": len(recorded), "calls_analyzed": len(analyzed),
        "calls_sales": len(sales), "next_step_agreed": len(agreed),
        "next_step_agreed_pct": _pct(len(agreed), len(sales)),
        "first_call_median_min": round(median(first_call_min)) if first_call_min else None,
        "top_objections": [{"type": t, "count": n} for t, n in objections.most_common(3)],
    }


def promise_without_task(ds: dict, now: int) -> list[dict]:
    """Последний разобранный звонок по открытой сделке: шаг согласован, открытой задачи нет (join кодом)."""
    with_task = {t["lead_id"] for t in ds["tasks"] if not t["is_completed"]}
    out = []
    for l in ds["leads"]:
        if l["status_id"] in (WON, LOST) or l["id"] in with_task:
            continue
        calls = [c for c in ds["calls"] if c["lead_id"] == l["id"] and c["analysis"] and c["analysis"]["analyzable"]]
        if calls:
            last = max(calls, key=lambda c: c["started_at"])
            if last["analysis"]["next_step_agreed"]:
                out.append({"lead_id": l["id"], "call_id": last["id"], "manager_id": l["manager_id"]})
    return out


def risk_deals(ds: dict, now: int, promises: list[dict]) -> list[dict]:
    open_tasks: dict[int, list[int]] = {}
    for t in ds["tasks"]:
        if not t["is_completed"]:
            open_tasks.setdefault(t["lead_id"], []).append(t["complete_till"])
    promise_by_lead = {p["lead_id"]: p["call_id"] for p in promises}
    out = []
    for l in ds["leads"]:
        if l["status_id"] in (WON, LOST):
            continue
        deadlines = open_tasks.get(l["id"], [])
        problems, overdue_days = [], 0
        if not deadlines:
            problems.append("no_open_tasks")
        elif min(deadlines) < now:
            problems.append("overdue_tasks")
            overdue_days = round((now - min(deadlines)) / DAY)
        if l["id"] in promise_by_lead:
            problems.append("promise_without_task")
        if problems:
            calls = [c for c in ds["calls"] if c["lead_id"] == l["id"]]
            last = max(calls, key=lambda c: c["started_at"]) if calls else None
            out.append({"lead_id": l["id"], "manager_id": l["manager_id"], "problems": problems,
                        "overdue_days": overdue_days, "price": l["price"],
                        "evidence_call_id": promise_by_lead.get(l["id"]) or (last["id"] if last else None)})
    weight = {"promise_without_task": 3, "overdue_tasks": 2, "no_open_tasks": 1}
    return sorted(out, key=lambda r: (-max(weight[p] for p in r["problems"]), -r["overdue_days"], -r["price"]))


ANOMALY_RULES = [  # метрика, направление «плохо», минимальная абсолютная разница с медианой остальных
    ("open_without_tasks_pct", "high", 12),
    ("open_with_overdue_pct", "high", 12),
    ("next_step_agreed_pct", "low", 15),
    ("first_call_median_min", "high", 20),
]


def anomalies(per_manager: dict[int, dict]) -> list[dict]:
    out = []
    for metric, bad, min_gap in ANOMALY_RULES:
        for mid, m in per_manager.items():
            others = [o[metric] for oid, o in per_manager.items() if oid != mid and o[metric] is not None]
            if m[metric] is None or not others:
                continue
            base = median(others)
            gap = m[metric] - base if bad == "high" else base - m[metric]
            if gap >= min_gap:
                out.append({"manager_id": mid, "metric": metric, "value": m[metric], "others_median": round(base)})
    return out


def build_fact_pack(ds: dict) -> dict:
    now, period_from = ds["snapshot_at"], ds["period"]["from"]
    team = _manager_slice(ds, None, now, period_from)
    per_manager = {m["id"]: _manager_slice(ds, m["id"], now, period_from) for m in ds["managers"]}
    unmatched = sum(1 for c in ds["calls"] if c["lead_id"] is None and c["started_at"] >= period_from)
    promises = promise_without_task(ds, now)
    risks = risk_deals(ds, now, promises)
    return {
        "period": ds["period"], "snapshot_at": now,
        "team": {**team, "calls_unmatched": unmatched,
                 "calls_unmatched_pct": _pct(unmatched, team["calls_total"]),
                 "analysis_coverage_pct": _pct(team["calls_analyzed"], team["calls_total"]),
                 "promise_without_task": len(promises),
                 "risk_deals": len(risks), "risk_deals_value": sum(r["price"] for r in risks)},
        "managers": {str(mid): {**m, "promise_without_task": sum(1 for p in promises if p["manager_id"] == mid)}
                     for mid, m in per_manager.items()},
        "anomalies": anomalies(per_manager),
        "risk_deals": risks,
        "not_available": ["План продаж: нет в amoCRM и телефонии", "Маржинальность сделок: нет в источниках"],
    }
