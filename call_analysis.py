"""Схема результата анализа звонка (structured output для LLM) и детерминированные проверки.

LLM возвращает JSON по CallAnalysis.model_json_schema(); всё, что ниже схемы, — обычный код:
сверка цитат с транскриптом, сверка «договорились о следующем шаге» с задачами в CRM, маршрутизация на ревью.
"""
import re
from typing import Literal

from pydantic import BaseModel, Field, model_validator

Asked = Literal["asked", "not_asked", "unclear"]


class Evidence(BaseModel):
    id: str
    speaker: Literal["manager", "customer"]
    start_sec: float = Field(ge=0)
    quote: str = Field(min_length=3)


class Claim(BaseModel):
    value: str
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(min_length=1)


class NextStep(BaseModel):
    agreed: bool
    what: str | None = None
    when_mentioned: str | None = None
    evidence: list[str] = []


class Qualification(BaseModel):
    need: Asked
    budget: Asked
    timeline: Asked
    decision_maker: Asked


class Objection(BaseModel):
    type: Literal["price", "timing", "competitor", "trust", "need", "other"]
    handled: Literal["yes", "partially", "no"]
    evidence: list[str] = Field(min_length=1)


class ChecklistItem(BaseModel):
    item: str
    status: Literal["done", "missed", "n/a"]
    evidence: list[str] = []


class Risk(BaseModel):
    type: str
    severity: Literal["low", "medium", "high"]
    evidence: list[str] = []


class CallAnalysis(BaseModel):
    schema_version: Literal["call_analysis.v1"] = "call_analysis.v1"
    prompt_version: str
    model: str
    call_id: str
    lead_id: int | None = None
    manager_user_id: int | None = None
    analyzable: bool
    skip_reason: str | None = None
    call_type: Literal["first_contact", "follow_up", "not_sales", "voicemail"]
    customer_intent: Claim | None = None
    outcome: Claim | None = None
    next_step: NextStep
    qualification: Qualification | None = None
    objections: list[Objection] = []
    script_checklist: list[ChecklistItem] = []
    risks: list[Risk] = []
    evidence: list[Evidence] = []
    needs_review: bool = False
    review_reasons: list[str] = []

    def referenced_ids(self) -> set[str]:
        refs = set(self.next_step.evidence)
        for claim in (self.customer_intent, self.outcome):
            if claim:
                refs.update(claim.evidence)
        for group in (self.objections, self.script_checklist, self.risks):
            for item in group:
                refs.update(item.evidence)
        return refs

    @model_validator(mode="after")
    def evidence_ids_exist(self):
        missing = self.referenced_ids() - {e.id for e in self.evidence}
        if missing:
            raise ValueError(f"ссылки на несуществующие evidence: {sorted(missing)}")
        return self


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text.lower().replace("ё", "е"))).strip()


def unverified_evidence(analysis: CallAnalysis, segments: list[dict], window_sec: float = 10.0) -> list[str]:
    """Цитата считается подтверждённой, если она дословно (после нормализации) есть в реплике
    того же спикера рядом с указанным таймкодом. segments: [{speaker, start, end, text}] из STT."""
    bad = []
    for ev in analysis.evidence:
        quote = _norm(ev.quote)
        ok = any(
            seg["speaker"] == ev.speaker
            and seg["start"] - window_sec <= ev.start_sec <= seg["end"] + window_sec
            and quote in _norm(seg["text"])
            for seg in segments
        )
        if not ok:
            bad.append(ev.id)
    return bad


def crm_followup_gap(analysis: CallAnalysis, open_task_lead_ids: set[int]) -> bool:
    """В разговоре следующий шаг согласован, а открытой задачи по сделке в CRM нет."""
    return analysis.next_step.agreed and analysis.lead_id is not None and analysis.lead_id not in open_task_lead_ids


def route_for_review(analysis: CallAnalysis, segments: list[dict], open_task_lead_ids: set[int],
                     min_confidence: float = 0.6) -> CallAnalysis:
    """Детерминированные правила: что уходит человеку. Confidence модели — только сигнал маршрутизации."""
    reasons = list(analysis.review_reasons)
    if bad := unverified_evidence(analysis, segments):
        reasons.append(f"цитаты не найдены в транскрипте: {bad}")
    low = [c for c in (analysis.customer_intent, analysis.outcome) if c and c.confidence < min_confidence]
    if low:
        reasons.append("низкая уверенность модели")
    if any(r.severity == "high" for r in analysis.risks):
        reasons.append("риск высокой серьёзности")
    risks = list(analysis.risks)
    if crm_followup_gap(analysis, open_task_lead_ids):
        risks.append(Risk(type="promise_without_crm_task", severity="high", evidence=analysis.next_step.evidence))
        reasons.append("следующий шаг согласован, задачи в CRM нет")
    return analysis.model_copy(update={"risks": risks, "needs_review": bool(reasons), "review_reasons": reasons})
