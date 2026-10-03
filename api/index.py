"""HTTP API демо (Vercel Python Function). LLM вызывается только в живом режиме.

Ключ: ANTHROPIC_API_KEY на сервере или ключ посетителя в заголовке X-Anthropic-Key (используется для одного
запроса, не логируется и не сохраняется). Без ключа интерфейс работает на сохранённых результатах.
"""
import hashlib
import os
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import llm  # noqa: E402
from build_demo_data import build  # noqa: E402
from call_analysis import CallAnalysis, CallExtraction, route_for_review  # noqa: E402
from demo_samples import SAMPLES, SAMPLES_BY_ID  # noqa: E402
from report_validator import validate_report  # noqa: E402
from sales_analytics import build_fact_pack  # noqa: E402
from transcript import parse_transcript  # noqa: E402

app = FastAPI(title="Sales department analysis demo")

MAX_CHARS = 6000
LIVE_PER_IP = 6            # живых запросов на IP за окно (только для серверного ключа)
LIVE_WINDOW_SEC = 600
_hits: dict[str, deque] = defaultdict(deque)  # best-effort: память одного инстанса функции


def resolve_key(request: Request) -> str | None:
    """Ключ посетителя важнее серверного. Серверный ключ — с ограничением частоты."""
    visitor = (request.headers.get("x-anthropic-key") or "").strip()
    if visitor:
        return visitor
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(503, "Живой режим выключен: добавьте свой ключ Anthropic API в настройках")
    ip = request.headers.get("x-forwarded-for", "?").split(",")[0].strip()
    now, q = time.time(), _hits[ip]
    while q and now - q[0] > LIVE_WINDOW_SEC:
        q.popleft()
    if len(q) >= LIVE_PER_IP:
        raise HTTPException(429, "Лимит живых запросов на серверном ключе исчерпан. Подождите 10 минут или добавьте свой ключ")
    q.append(now)
    return None


class AnalyzeRequest(BaseModel):
    transcript: str = Field(max_length=MAX_CHARS)
    mode: Literal["cached", "live"]
    sample_id: str | None = None
    lead_has_open_task: bool = False


@app.get("/api/health")
def health():
    return {"server_key": bool(os.environ.get("ANTHROPIC_API_KEY")), "model": llm.MODEL,
            "prompt_version": llm.PROMPT_VERSION}


@app.get("/api/samples")
def samples():
    return [{k: s[k] for k in ("id", "title", "description", "transcript", "lead_has_open_task")} for s in SAMPLES]


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest, request: Request):
    segments = parse_transcript(req.transcript)
    if not segments:
        raise HTTPException(422, "Не нашёл реплик. Формат строки: «[00:12] Менеджер: текст» или «Клиент: текст»")

    if req.mode == "cached":
        sample = SAMPLES_BY_ID.get(req.sample_id or "")
        if sample is None:
            raise HTTPException(404, "Нет сохранённого разбора для этого звонка")
        extraction = CallExtraction.model_validate(sample["extraction"])
        meta = {"model": "сохранённый пример (Claude)", "source": "cached"}
    else:
        key = resolve_key(request)
        try:
            extraction, usage = llm.extract(segments, api_key=key)
        except llm.ExtractionError as e:
            raise HTTPException(502, str(e)) from e
        meta = {"model": usage["model"], "source": "live", "usage": usage}

    call_id = "demo-" + hashlib.sha256(req.transcript.encode()).hexdigest()[:12]
    analysis = CallAnalysis(**extraction.model_dump(), prompt_version=llm.PROMPT_VERSION,
                            model=meta["model"], call_id=call_id, lead_id=None)
    routed = route_for_review(analysis, segments, lead_has_open_task=req.lead_has_open_task)
    return {"segments": segments, "analysis": routed.model_dump(), **meta}


@app.post("/api/report")
def report(request: Request):
    """Живой Report Agent по fact pack синтетического отдела + валидация чисел и ссылок кодом."""
    key = resolve_key(request)
    ds = build()
    fact_pack = build_fact_pack(ds)
    sample_calls = [c["id"] for c in ds["calls"] if c["sample_id"]]
    try:
        draft, usage = llm.write_report(fact_pack, ds["managers"], sample_calls, api_key=key)
    except llm.ExtractionError as e:
        raise HTTPException(502, str(e)) from e
    result = draft.model_dump()
    known = {l["id"] for l in ds["leads"]} | {c["id"] for c in ds["calls"]}
    return {"report": result, "validation": validate_report(result, fact_pack, known), "usage": usage}
