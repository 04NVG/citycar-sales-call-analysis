"""Синтетический звонок (данные выдуманы для теста): проверки схемы, цитат и связи с CRM."""
import pytest
from pydantic import ValidationError

from call_analysis import CRM_GAP_TEXT, CallAnalysis, CallExtraction, route_for_review, unverified_evidence

SEGMENTS = [
    {"speaker": "manager", "start": 0.0, "end": 6.0, "text": "Добрый день, меня зовут Анна, компания."},
    {"speaker": "customer", "start": 6.5, "end": 14.0, "text": "Здравствуйте. Мне кажется, у вас дороговато."},
    {"speaker": "manager", "start": 180.0, "end": 188.0, "text": "Давайте я перезвоню в пятницу с расчётом, хорошо?"},
    {"speaker": "customer", "start": 188.5, "end": 190.0, "text": "Да, договорились."},
]

EXTRACTION = {
    "analyzable": True, "skip_reason": None, "call_type": "first_contact",
    "summary": "Клиент считает цену высокой, договорились о повторном звонке с расчётом.",
    "customer_intent": None, "qualification": None,
    "outcome": {"value": "callback", "confidence": 0.9, "evidence": ["e2"]},
    "next_step": {"agreed": True, "what": "перезвонить с расчётом", "when_mentioned": "в пятницу",
                  "evidence": ["e2", "e3"]},
    "objections": [{"type": "price", "handled": "partially", "evidence": ["e1"]}],
    "script_checklist": [], "risks": [],
    "evidence": [
        {"id": "e1", "speaker": "customer", "start_sec": 7.0, "quote": "у вас дороговато"},
        {"id": "e2", "speaker": "manager", "start_sec": 181.0, "quote": "перезвоню в пятницу с расчетом"},
        {"id": "e3", "speaker": "customer", "start_sec": 189.0, "quote": "Да, договорились"},
    ],
}


def make(**overrides) -> CallAnalysis:
    meta = {"prompt_version": "test", "model": "test", "call_id": "c1", "lead_id": 100}
    return CallAnalysis.model_validate({**EXTRACTION, **meta, **overrides})


def test_reference_to_missing_evidence_is_rejected():
    with pytest.raises(ValidationError):
        CallExtraction.model_validate({**EXTRACTION, "outcome": {"value": "x", "confidence": 0.9, "evidence": ["e9"]}})


def test_quotes_are_checked_against_transcript():
    assert unverified_evidence(make(), SEGMENTS) == []
    invented = make(evidence=[
        {"id": "e1", "speaker": "customer", "start_sec": 7.0, "quote": "у вас дороговато"},
        {"id": "e2", "speaker": "manager", "start_sec": 181.0, "quote": "цену назову завтра"},
        {"id": "e3", "speaker": "manager", "start_sec": 189.0, "quote": "Да, договорились"},  # не тот спикер
    ])
    assert unverified_evidence(invented, SEGMENTS) == ["e2", "e3"]


def test_agreed_next_step_without_crm_task_goes_to_review():
    routed = route_for_review(make(), SEGMENTS, lead_has_open_task=False)
    assert routed.needs_review
    assert [r.description for r in routed.risks] == [CRM_GAP_TEXT]
    # повторный прогон не дублирует риск
    again = route_for_review(routed, SEGMENTS, lead_has_open_task=False)
    assert len(again.risks) == 1


def test_clean_call_with_crm_task_is_not_escalated():
    routed = route_for_review(make(), SEGMENTS, lead_has_open_task=True)
    assert not routed.needs_review and routed.review_reasons == [] and routed.risks == []


def test_json_schema_is_exportable_for_structured_output():
    schema = CallExtraction.model_json_schema()
    assert {"next_step", "evidence", "risks"} <= set(schema["properties"])
    assert "prompt_version" not in schema["properties"]  # метаданные заполняет код, не модель
