"""Синтетический звонок (данные выдуманы для теста): проверки схемы, цитат и связи с CRM."""
import pytest
from pydantic import ValidationError

from call_analysis import CallAnalysis, route_for_review, unverified_evidence

SEGMENTS = [
    {"speaker": "manager", "start": 0.0, "end": 6.0, "text": "Добрый день, меня зовут Анна, компания."},
    {"speaker": "customer", "start": 6.5, "end": 14.0, "text": "Здравствуйте. Мне кажется, у вас дороговато."},
    {"speaker": "manager", "start": 180.0, "end": 188.0, "text": "Давайте я перезвоню в пятницу с расчётом, хорошо?"},
    {"speaker": "customer", "start": 188.5, "end": 190.0, "text": "Да, договорились."},
]


def make(**overrides) -> CallAnalysis:
    data = {
        "prompt_version": "test", "model": "test", "call_id": "c1", "lead_id": 100, "manager_user_id": 7,
        "analyzable": True, "call_type": "first_contact",
        "outcome": {"value": "callback", "confidence": 0.9, "evidence": ["e2"]},
        "next_step": {"agreed": True, "what": "перезвонить с расчётом", "when_mentioned": "пятница",
                      "evidence": ["e2", "e3"]},
        "objections": [{"type": "price", "handled": "partially", "evidence": ["e1"]}],
        "evidence": [
            {"id": "e1", "speaker": "customer", "start_sec": 7.0, "quote": "у вас дороговато"},
            {"id": "e2", "speaker": "manager", "start_sec": 181.0, "quote": "перезвоню в пятницу с расчетом"},
            {"id": "e3", "speaker": "customer", "start_sec": 189.0, "quote": "Да, договорились"},
        ],
    }
    data.update(overrides)
    return CallAnalysis.model_validate(data)


def test_reference_to_missing_evidence_is_rejected():
    with pytest.raises(ValidationError):
        make(outcome={"value": "callback", "confidence": 0.9, "evidence": ["e999"]})


def test_quotes_are_checked_against_transcript():
    assert unverified_evidence(make(), SEGMENTS) == []
    invented = make(evidence=[
        {"id": "e1", "speaker": "customer", "start_sec": 7.0, "quote": "у вас дороговато"},
        {"id": "e2", "speaker": "manager", "start_sec": 181.0, "quote": "цену назову завтра"},
        {"id": "e3", "speaker": "manager", "start_sec": 189.0, "quote": "Да, договорились"},  # не тот спикер
    ])
    assert unverified_evidence(invented, SEGMENTS) == ["e2", "e3"]


def test_agreed_next_step_without_crm_task_goes_to_review():
    routed = route_for_review(make(), SEGMENTS, open_task_lead_ids=set())
    assert routed.needs_review
    assert any(r.type == "promise_without_crm_task" for r in routed.risks)


def test_clean_call_with_crm_task_is_not_escalated():
    routed = route_for_review(make(), SEGMENTS, open_task_lead_ids={100})
    assert not routed.needs_review and routed.review_reasons == []


def test_json_schema_is_exportable_for_structured_output():
    schema = CallAnalysis.model_json_schema()
    assert "next_step" in schema["properties"] and "evidence" in schema["properties"]
