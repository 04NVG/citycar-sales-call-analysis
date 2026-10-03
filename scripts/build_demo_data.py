"""Генерирует синтетический отдел продаж (как после CRM Sync + Call Ingest) и public/demo-data.json.

Все люди, сделки и звонки выдуманы. Генерация детерминированная (seed), поэтому отчёт воспроизводим.
Запуск: python scripts/build_demo_data.py
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from demo_report import CACHED_REPORT  # noqa: E402
from demo_samples import SAMPLES  # noqa: E402
from report_validator import validate_report  # noqa: E402
from sales_analytics import LOST, WON, build_fact_pack  # noqa: E402

DAY = 86400
SNAPSHOT = 1791007200  # 2026-10-03 09:00 МСК
PERIOD_FROM = SNAPSHOT - 30 * DAY

MANAGERS = [  # профиль задаёт «характер» данных, отчёт его не знает — он видит только факты
    {"id": 7001, "name": "Анна Соколова", "n": 24, "no_task": .08, "overdue": .08, "agree": .80, "first_call": 11},
    {"id": 7002, "name": "Дмитрий Ковалёв", "n": 22, "no_task": .40, "overdue": .10, "agree": .70, "first_call": 22},
    {"id": 7003, "name": "Марина Лебедева", "n": 23, "no_task": .08, "overdue": .42, "agree": .68, "first_call": 17},
    {"id": 7004, "name": "Игорь Петров", "n": 21, "no_task": .14, "overdue": .12, "agree": .36, "first_call": 58},
]
STATUSES = {101: "Новая заявка", 102: "Квалификация", 103: "Тест-драйв", 104: "Кредит / трейд-ин",
            105: "Договор", WON: "Успешно реализовано", LOST: "Закрыто и не реализовано"}
INTERESTS = ["Кроссовер, трейд-ин", "Седан в кредит", "Семейный минивэн", "Кроссовер в наличии", "Седан, наличные",
             "Внедорожник, лизинг", "Хэтчбек для города", "Кроссовер, кредит", "Электромобиль", "Пикап для бизнеса"]
OBJECTIONS = [("price", 5), ("timing", 2), ("competitor", 3), ("trust", 1), ("need", 1)]


def pick(rng, weighted):
    return rng.choices([w[0] for w in weighted], [w[1] for w in weighted])[0]


def build() -> dict:
    rng = random.Random(20261003)
    leads, tasks, calls = [], [], []
    lead_id, task_id, call_id = 3104000, 5520000, 9100000

    for m in MANAGERS:
        for _ in range(m["n"]):
            lead_id += 1
            created = SNAPSHOT - rng.randint(1 * DAY, 52 * DAY)
            closed_at, status = None, rng.choice([101, 102, 103, 103, 104, 104, 105])
            if rng.random() < (0.38 if created < PERIOD_FROM else 0.18):
                status = WON if rng.random() < 0.45 else LOST
                closed_at = max(created, PERIOD_FROM) + rng.randint(DAY, max(2 * DAY, SNAPSHOT - max(created, PERIOD_FROM) - DAY))
                closed_at = min(closed_at, SNAPSHOT - 3600)
            lead = {"id": lead_id, "name": rng.choice(INTERESTS), "manager_id": m["id"], "status_id": status,
                    "price": rng.randrange(1_400_000, 5_200_000, 10_000), "created_at": created, "closed_at": closed_at}
            leads.append(lead)

            for _ in range(rng.randint(1, 3)):  # история выполненных задач
                task_id += 1
                tasks.append({"id": task_id, "lead_id": lead_id, "complete_till": created + rng.randint(DAY, 9 * DAY),
                              "is_completed": True})
            if closed_at is None and rng.random() >= m["no_task"]:
                for _ in range(rng.choice([1, 1, 2])):
                    task_id += 1
                    overdue = rng.random() < m["overdue"]
                    due = SNAPSHOT - rng.randint(DAY // 2, 14 * DAY) if overdue else SNAPSHOT + rng.randint(DAY // 4, 6 * DAY)
                    tasks.append({"id": task_id, "lead_id": lead_id, "complete_till": due, "is_completed": False})

            end = closed_at or SNAPSHOT
            t = created + int(rng.expovariate(1 / (m["first_call"] * 60)))
            for i in range(rng.randint(1, 5)):
                if t >= end:
                    break
                call_id += 1
                short = rng.random() < 0.14
                recorded = rng.random() < 0.94
                analysis = None
                if recorded:
                    analyzable = not short
                    agreed = analyzable and rng.random() < m["agree"]
                    objections = [pick(rng, OBJECTIONS)] if analyzable and rng.random() < 0.55 else []
                    missed = []
                    if analyzable and not agreed and rng.random() < 0.7:
                        missed.append("next_step_fixed")
                    if analyzable and rng.random() < (0.35 if m["id"] == 7004 else 0.12):
                        missed.append("needs_discovery")
                    analysis = {"analyzable": analyzable, "call_type": ("voicemail" if short else
                                ("first_contact" if i == 0 else "follow_up")),
                                "next_step_agreed": agreed, "objections": objections, "checklist_missed": missed,
                                "confidence": round(rng.uniform(0.62, 0.96), 2) if analyzable else None}
                calls.append({"id": call_id, "lead_id": lead_id, "manager_id": m["id"], "started_at": t,
                              "direction": "out" if i == 0 or rng.random() < 0.7 else "in",
                              "duration_sec": rng.randint(8, 19) if short else rng.randint(55, 640),
                              "has_recording": recorded, "analysis": analysis, "sample_id": None})
                t += rng.randint(DAY // 2, 6 * DAY)

    for _ in range(14):  # звонки с номеров, которых нет в CRM
        call_id += 1
        m = rng.choice(MANAGERS)
        calls.append({"id": call_id, "lead_id": None, "manager_id": m["id"],
                      "started_at": SNAPSHOT - rng.randint(DAY, 29 * DAY), "direction": "in",
                      "duration_sec": rng.randint(40, 300), "has_recording": True, "analysis": None, "sample_id": None})

    attach_samples(leads, tasks, calls)
    calls.sort(key=lambda c: c["started_at"])
    return {"generated_note": "Синтетические данные: люди, сделки и звонки выдуманы.",
            "snapshot_at": SNAPSHOT, "period": {"from": PERIOD_FROM, "to": SNAPSHOT, "days": 30},
            "managers": [{"id": m["id"], "name": m["name"]} for m in MANAGERS],
            "statuses": {str(k): v for k, v in STATUSES.items()}, "leads": leads, "tasks": tasks, "calls": calls}


def attach_samples(leads, tasks, calls):
    """Три звонка с полным транскриптом привязываем к подходящим сделкам, данные звонка берём из разбора."""
    open_tasks = {t["lead_id"] for t in tasks if not t["is_completed"]}

    def last_call(lead_id):
        cs = [c for c in calls if c["lead_id"] == lead_id]
        return max(cs, key=lambda c: c["started_at"]) if cs else None

    def candidates(manager_id, has_task):
        return [l for l in leads if l["manager_id"] == manager_id and l["closed_at"] is None
                and (l["id"] in open_tasks) == has_task and last_call(l["id"]) and l["created_at"] < SNAPSHOT - 3 * DAY]

    plan = [("first-contact", 7001, True, 2), ("promise-no-task", 7004, False, 3), ("voicemail", 7002, True, 1)]
    for sample_id, manager_id, has_task, days_ago in plan:
        sample = next(s for s in SAMPLES if s["id"] == sample_id)
        found = candidates(manager_id, has_task) or candidates(manager_id, not has_task)
        lead = found[0]
        if not has_task:  # сценарий «обещал, но задачи нет»: открытых задач по сделке быть не должно
            for t in tasks:
                if t["lead_id"] == lead["id"]:
                    t["is_completed"] = True
            open_tasks.discard(lead["id"])
        call = last_call(lead["id"])
        ex = sample["extraction"]
        segs = sample["transcript"].splitlines()
        call.update({"sample_id": sample_id, "has_recording": True, "direction": "out",
                     "started_at": max(call["started_at"], SNAPSHOT - days_ago * DAY - 5 * 3600),
                     "duration_sec": 6 + 5 * len(segs) if sample_id == "voicemail" else 30 + 6 * len(segs),
                     "analysis": {"analyzable": ex["analyzable"], "call_type": ex["call_type"],
                                  "next_step_agreed": ex["next_step"]["agreed"],
                                  "objections": [o["type"] for o in ex["objections"]],
                                  "checklist_missed": [c["item"] for c in ex["script_checklist"] if c["status"] == "missed"],
                                  "confidence": ex["outcome"]["confidence"] if ex["outcome"] else None}})
        if sample_id == "first-contact":
            lead.update({"name": "Кроссовер, трейд-ин", "status_id": 103})
        if sample_id == "promise-no-task":
            lead.update({"name": "Седан в кредит", "status_id": 104})


def main():
    ds = build()
    fact_pack = build_fact_pack(ds)
    known_ids = {l["id"] for l in ds["leads"]} | {c["id"] for c in ds["calls"]}
    validation = validate_report(CACHED_REPORT, fact_pack, known_ids)
    samples = [{k: s[k] for k in ("id", "title", "description", "transcript", "lead_has_open_task", "extraction")}
               for s in SAMPLES]
    out = {**ds, "fact_pack": fact_pack, "report": CACHED_REPORT, "report_validation": validation, "samples": samples}
    path = ROOT / "public" / "demo-data.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size // 1024} KB); validation ok={validation['ok']}")
    return fact_pack, validation


if __name__ == "__main__":
    fp, v = main()
    if "--facts" in sys.argv:
        print(json.dumps({k: fp[k] for k in ("team", "managers", "anomalies")}, ensure_ascii=False, indent=1))
        print("risk_deals:", len(fp["risk_deals"]), json.dumps(fp["risk_deals"][:8], ensure_ascii=False))
        print(json.dumps(v, ensure_ascii=False))
