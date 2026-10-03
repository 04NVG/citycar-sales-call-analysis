"""Схема анализа звонка и детерминированные проверки.

CallExtraction — то, что заполняет LLM (structured output по JSON Schema этой модели).
CallAnalysis   — CallExtraction + метаданные и решение о ревью, которые добавляет код.
Всё ниже схем — обычный код: сверка цитат с транскриптом, сверка «договорились о шаге» с задачами в CRM,
маршрутизация на ревью.
"""
import re
from typing import Literal

from pydantic import BaseModel, Field, model_validator

Asked = Literal["asked", "not_asked", "unclear"]


class Evidence(BaseModel):
    id: str = Field(description="e1, e2, ...")
    speaker: Literal["manager", "customer"]
    start_sec: float = Field(ge=0, description="Время начала реплики, из которой взята цитата")
    quote: str = Field(min_length=3, description="Дословный фрагмент реплики, без перефразирования")


class Claim(BaseModel):
    value: str
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(description="id из evidence")


class NextStep(BaseModel):
    agreed: bool = Field(description="Клиент явно согласился на конкретный следующий шаг")
    what: str | None
    when_mentioned: str | None = Field(description="Срок так, как он прозвучал в разговоре")
    evidence: list[str]


class Qualification(BaseModel):
    need: Asked
    budget: Asked
    timeline: Asked
    decision_maker: Asked


class Objection(BaseModel):
    type: Literal["price", "timing", "competitor", "trust", "need", "other"]
    handled: Literal["yes", "partially", "no"]
    evidence: list[str]


class ChecklistItem(BaseModel):
    item: Literal["greeting_and_name", "needs_discovery", "offer_presented", "objection_handling", "next_step_fixed"]
    status: Literal["done", "missed", "n/a"]
    evidence: list[str]


class Risk(BaseModel):
    type: Literal["promise_without_followup", "customer_unhappy", "lost_to_competitor", "manager_incorrect_info",
                  "rude_or_pressure", "other"]
    severity: Literal["low", "medium", "high"]
    description: str
    evidence: list[str]


class CallExtraction(BaseModel):
    """Ответ модели. Никаких выводов о сотруднике — только то, что слышно в разговоре."""
    analyzable: bool = Field(description="false для автоответчика, обрыва, не-продажного звонка")
    skip_reason: str | None
    call_type: Literal["first_contact", "follow_up", "not_sales", "voicemail"]
    summary: str = Field(description="1–2 предложения: о чём разговор и чем закончился")
    customer_intent: Claim | None
    outcome: Claim | None
    next_step: NextStep
    qualification: Qualification | None
    objections: list[Objection]
    script_checklist: list[ChecklistItem]
    risks: list[Risk]
    evidence: list[Evidence]

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


class CallAnalysis(CallExtraction):
    schema_version: Literal["call_analysis.v1"] = "call_analysis.v1"
    prompt_version: str
    model: str
    call_id: str
    lead_id: int | None = None
    manager_user_id: int | None = None
    unverified_evidence: list[str] = []
    needs_review: bool = False
    review_reasons: list[str] = []


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text.lower().replace("ё", "е"))).strip()


def unverified_evidence(analysis: CallExtraction, segments: list[dict], window_sec: float = 10.0) -> list[str]:
    """Цитата подтверждена, если она дословно (после нормализации) есть в реплике того же спикера
    рядом с указанным таймкодом. segments: [{speaker, start, end, text}] из STT."""
    bad = []
    for ev in analysis.evidence:
        quote = _norm(ev.quote)
        ok = bool(quote) and any(
            seg["speaker"] == ev.speaker
            and seg["start"] - window_sec <= ev.start_sec <= seg["end"] + window_sec
            and quote in _norm(seg["text"])
            for seg in segments
        )
        if not ok:
            bad.append(ev.id)
    return bad


def crm_followup_gap(analysis: CallAnalysis, lead_has_open_task: bool) -> bool:
    """В разговоре следующий шаг согласован, а открытой задачи по сделке в CRM нет."""
    return analysis.analyzable and analysis.next_step.agreed and not lead_has_open_task


def route_for_review(analysis: CallAnalysis, segments: list[dict], lead_has_open_task: bool,
                     min_confidence: float = 0.6) -> CallAnalysis:
    """Детерминированные правила: что уходит человеку. Confidence модели — только сигнал маршрутизации."""
    reasons: list[str] = []
    bad = unverified_evidence(analysis, segments)
    if bad:
        reasons.append(f"цитаты не найдены в транскрипте: {', '.join(bad)}")
    if any(c and c.confidence < min_confidence for c in (analysis.customer_intent, analysis.outcome)):
        reasons.append("низкая уверенность модели")
    if any(r.severity == "high" for r in analysis.risks):
        reasons.append("риск высокой серьёзности")
    risks = [r for r in analysis.risks if r.description != CRM_GAP_TEXT]
    if crm_followup_gap(analysis, lead_has_open_task):
        risks.append(Risk(type="promise_without_followup", severity="high", description=CRM_GAP_TEXT,
                          evidence=analysis.next_step.evidence))
        reasons.append("следующий шаг согласован, а открытой задачи в CRM нет")
    return analysis.model_copy(update={"risks": risks, "unverified_evidence": bad,
                                       "needs_review": bool(reasons), "review_reasons": reasons})


CRM_GAP_TEXT = "Добавлено кодом: договорённость есть в разговоре, задачи в CRM нет"
