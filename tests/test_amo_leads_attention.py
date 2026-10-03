"""amoCRM API замокан: проверяем пагинацию, повтор на 429, пустой ответ 204 и классификацию сделок."""
import importlib
import time

import pytest

NOW = int(time.time())


class FakeResponse:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


@pytest.fixture
def amo(monkeypatch):
    monkeypatch.setenv("AMO_SUBDOMAIN", "test")
    monkeypatch.setenv("AMO_TOKEN", "token")
    module = importlib.import_module("amo_leads_attention")
    monkeypatch.setattr(module.time, "sleep", lambda s: None)
    return module


def test_leads_without_open_or_with_overdue_tasks(amo, monkeypatch):
    calls = []
    throttled = {"done": False}

    def fake_get(url, params, timeout):
        calls.append((url, dict(params)))
        if url.endswith("/leads"):
            if params["page"] == 1 and not throttled["done"]:
                throttled["done"] = True
                return FakeResponse(429)
            if params["page"] == 1:
                return FakeResponse(200, {"_embedded": {"leads": [
                    {"id": 1, "name": "A", "status_id": 10, "responsible_user_id": 7},
                    {"id": 2, "name": "B", "status_id": 142, "responsible_user_id": 7},
                ]}, "_links": {"next": {"href": "page=2"}}})
            return FakeResponse(200, {"_embedded": {"leads": [
                {"id": 3, "name": "C", "status_id": 11, "responsible_user_id": 8},
                {"id": 4, "name": "D", "status_id": 11, "responsible_user_id": 8},
            ]}, "_links": {}})
        assert params["filter[is_completed]"] == 0
        assert params["filter[entity_type]"] == "leads"
        return FakeResponse(200, {"_embedded": {"tasks": [
            {"entity_id": 1, "complete_till": NOW - 7200},
            {"entity_id": 1, "complete_till": NOW + 3600},
            {"entity_id": 3, "complete_till": NOW + 3600},
        ]}, "_links": {}})

    monkeypatch.setattr(amo.S, "get", fake_get)
    result = amo.leads_needing_attention()

    assert [r["lead_id"] for r in result] == [1, 4]  # 2 закрыта, у 3 задача в срок
    assert result[0]["problem"] == "overdue_tasks" and result[0]["overdue_count"] == 1
    assert result[1]["problem"] == "no_open_tasks"
    assert all(p["limit"] == 250 for _, p in calls)
    assert len(calls) == 4  # 429 + 2 страницы сделок + 1 страница задач


def test_empty_account_returns_204(amo, monkeypatch):
    monkeypatch.setattr(amo.S, "get", lambda url, params, timeout: FakeResponse(204))
    assert amo.leads_needing_attention() == []
