import os, time, requests

BASE = f"https://{os.environ['AMO_SUBDOMAIN']}.amocrm.ru/api/v4"
S = requests.Session()
S.headers["Authorization"] = f"Bearer {os.environ['AMO_TOKEN']}"  # долгосрочный или OAuth access token
CLOSED = {142, 143}  # системные статусы: «Успешно реализовано» / «Закрыто и не реализовано»

def fetch_all(path: str, key: str, params: dict):
    """Обход пагинации amoCRM v4: limit<=250, page=1..N, пока в ответе есть _links.next."""
    page = 1
    while True:
        for attempt in range(5):
            r = S.get(f"{BASE}/{path}", params={**params, "limit": 250, "page": page}, timeout=30)
            if r.status_code != 429:            # лимит: 7 запросов/сек на интеграцию
                break
            time.sleep(2 ** attempt)
        if r.status_code == 204:                # пустая выборка — тела нет
            return
        r.raise_for_status()
        data = r.json()
        yield from data["_embedded"][key]
        if "next" not in data.get("_links", {}):
            return
        page += 1
        time.sleep(0.2)                         # держимся ниже лимита

def leads_needing_attention(pipeline_id: int | None = None) -> list[dict]:
    now = int(time.time())
    lead_filter = {"filter[pipeline_id]": pipeline_id} if pipeline_id else {}
    leads = [l for l in fetch_all("leads", "leads", lead_filter) if l["status_id"] not in CLOSED]
    # Задачи не вложены в сделку: берём все открытые задачи по сделкам и группируем по entity_id
    deadlines: dict[int, list[int]] = {}
    for t in fetch_all("tasks", "tasks", {"filter[is_completed]": 0, "filter[entity_type]": "leads"}):
        deadlines.setdefault(t["entity_id"], []).append(t["complete_till"])
    result = []
    for lead in leads:
        dl = deadlines.get(lead["id"], [])
        overdue = [d for d in dl if d < now]    # complete_till — unix timestamp (UTC)
        if dl and not overdue:
            continue
        result.append({
            "lead_id": lead["id"], "name": lead["name"], "status_id": lead["status_id"],
            "responsible_user_id": lead["responsible_user_id"],
            "problem": "overdue_tasks" if overdue else "no_open_tasks",
            "overdue_count": len(overdue),
            "max_overdue_hours": round((now - min(overdue)) / 3600, 1) if overdue else None,
        })
    return sorted(result, key=lambda x: -(x["max_overdue_hours"] or 0))
