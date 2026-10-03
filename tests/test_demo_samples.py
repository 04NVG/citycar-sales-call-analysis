"""Сохранённые разборы демо проходят те же проверки, что и живые: схема + дословные цитаты."""
import pytest
from fastapi.testclient import TestClient

from api.index import app
from call_analysis import CallExtraction, unverified_evidence
from demo_samples import SAMPLES
from transcript import parse_transcript


@pytest.mark.parametrize("sample", SAMPLES, ids=lambda s: s["id"])
def test_cached_extraction_quotes_are_verbatim(sample):
    extraction = CallExtraction.model_validate(sample["extraction"])
    assert unverified_evidence(extraction, parse_transcript(sample["transcript"])) == []


def test_parse_transcript_with_and_without_timestamps():
    segs = parse_transcript("[01:05] Менеджер: Добрый день\nКлиент: Здравствуйте\nпродолжение реплики")
    assert [(s["speaker"], s["start"]) for s in segs] == [("manager", 65.0), ("customer", 70.0)]
    assert segs[1]["text"] == "Здравствуйте продолжение реплики"


def test_api_routes_promise_without_task_to_review(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    client = TestClient(app)
    sample = next(s for s in SAMPLES if s["id"] == "promise-no-task")
    body = {"transcript": sample["transcript"], "mode": "cached", "sample_id": sample["id"]}

    flagged = client.post("/api/analyze", json={**body, "lead_has_open_task": False}).json()
    assert flagged["analysis"]["needs_review"] is True

    clean = client.post("/api/analyze", json={**body, "lead_has_open_task": True}).json()
    assert clean["analysis"]["needs_review"] is False

    edited = body["transcript"].replace("жду звонка в пятницу", "подумаю")
    broken = client.post("/api/analyze", json={**body, "transcript": edited, "lead_has_open_task": True}).json()
    assert broken["analysis"]["unverified_evidence"] == ["e4"]

    assert client.post("/api/analyze", json={**body, "mode": "live"}).status_code == 503
    assert client.get("/api/health").json()["server_key"] is False
