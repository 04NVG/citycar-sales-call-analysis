"""HTTP API демо (Vercel Python Function). LLM вызывается только в /api/analyze с mode=live."""
import hashlib
import os
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from call_analysis import CallAnalysis, CallExtraction, route_for_review  # noqa: E402
from demo_samples import SAMPLES, SAMPLES_BY_ID  # noqa: E402
from transcript import parse_transcript  # noqa: E402
import llm  # noqa: E402

app = FastAPI(title="Sales call analysis demo")

MAX_CHARS = 6000
LIVE_PER_IP = 5            # живых разборов на IP за окно
LIVE_WINDOW_SEC = 600
_hits: dict[str, deque] = defaultdict(deque)  # best-effort: память одного инстанса функции


def live_enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def check_rate_limit(ip: str) -> None:
    now, q = time.time(), _hits[ip]
    while q and now - q[0] > LIVE_WINDOW_SEC:
        q.popleft()
    if len(q) >= LIVE_PER_IP:
        raise HTTPException(429, "Лимит живых разборов исчерпан, попробуйте позже")
    q.append(now)


class AnalyzeRequest(BaseModel):
    transcript: str = Field(max_length=MAX_CHARS)
    mode: Literal["cached", "live"]
    sample_id: str | None = None
    lead_has_open_task: bool = False


@app.get("/api/health")
def health():
    return {"live": live_enabled(), "model": llm.MODEL, "prompt_version": llm.PROMPT_VERSION}


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
        if not live_enabled():
            raise HTTPException(503, "Живой режим не настроен: на сервере нет ANTHROPIC_API_KEY")
        check_rate_limit(request.headers.get("x-forwarded-for", "?").split(",")[0].strip())
        try:
            extraction, usage = llm.extract(segments)
        except llm.ExtractionError as e:
            raise HTTPException(502, str(e)) from e
        meta = {"model": usage["model"], "source": "live", "usage": usage}

    call_id = "demo-" + hashlib.sha256(req.transcript.encode()).hexdigest()[:12]
    analysis = CallAnalysis(**extraction.model_dump(), prompt_version=llm.PROMPT_VERSION,
                            model=meta["model"], call_id=call_id, lead_id=None)
    routed = route_for_review(analysis, segments, lead_has_open_task=req.lead_has_open_task)
    return {"segments": segments, "analysis": routed.model_dump(), **meta}
