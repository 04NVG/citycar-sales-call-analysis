"""Fact pack считается кодом детерминированно, а валидатор ловит числа и ссылки, которых нет в данных."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from build_demo_data import build  # noqa: E402
from demo_report import CACHED_REPORT  # noqa: E402
from report_validator import numbers_in_text, validate_report  # noqa: E402
from sales_analytics import build_fact_pack  # noqa: E402


def setup_module():
    global DS, FP, KNOWN
    DS = build()
    FP = build_fact_pack(DS)
    KNOWN = {l["id"] for l in DS["leads"]} | {c["id"] for c in DS["calls"]}


def test_fact_pack_is_deterministic_and_consistent():
    assert build_fact_pack(build()) == FP
    team, managers = FP["team"], FP["managers"].values()
    assert team["leads_open"] == sum(m["leads_open"] for m in managers)
    assert team["open_without_tasks"] == sum(m["open_without_tasks"] for m in managers)
    assert team["promise_without_task"] == sum(m["promise_without_task"] for m in managers)
    assert team["risk_deals"] == len(FP["risk_deals"])


def test_promise_without_task_has_no_open_task():
    open_task_leads = {t["lead_id"] for t in DS["tasks"] if not t["is_completed"]}
    for r in FP["risk_deals"]:
        if "promise_without_task" in r["problems"]:
            assert r["lead_id"] not in open_task_leads


def test_cached_report_passes_validation():
    v = validate_report(CACHED_REPORT, FP, KNOWN)
    assert v["ok"] and v["numbers_checked"] > 20


def test_validator_catches_invented_number_and_reference():
    bad = {"insights": [{"text": "Конверсия выросла на 4321% за 30 дней", "evidence": [123]}], "recommendations": []}
    v = validate_report(bad, FP, KNOWN)
    assert [u["number"] for u in v["unknown_numbers"]] == [4321.0]  # 30 есть в fact pack (длина периода)
    assert v["bad_refs"] == [123] and not v["ok"]


def test_numbers_in_text_handles_thousands_and_decimals():
    assert numbers_in_text("Сделка 5 060 000 ₽, доля 12,5% и 7") == [5060000.0, 12.5, 7.0]
