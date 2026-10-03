"""Validator: каждое число в тексте Report Agent должно существовать в fact pack, каждая ссылка — в данных."""
import re

NUM = re.compile(r"(?<![\w.])(\d{1,3}(?:[  ]\d{3})+|\d+(?:[.,]\d+)?)(?![\w])")


def _numbers_in(obj, out: set[float]) -> set[float]:
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        out.add(round(float(obj), 1))
    elif isinstance(obj, dict):
        for v in obj.values():
            _numbers_in(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _numbers_in(v, out)
    return out


def numbers_in_text(text: str) -> list[float]:
    return [round(float(re.sub(r"[  ]", "", m).replace(",", ".")), 1) for m in NUM.findall(text)]


def validate_report(report: dict, fact_pack: dict, known_ids: set[int]) -> dict:
    allowed = _numbers_in(fact_pack, set())
    checked, unknown, bad_refs = 0, [], []
    for block in report["insights"] + report["recommendations"]:
        for n in numbers_in_text(block["text"]):
            checked += 1
            if n not in allowed:
                unknown.append({"text": block["text"], "number": n})
        for ref in block.get("evidence", []):
            if ref not in known_ids:
                bad_refs.append(ref)
    return {"numbers_checked": checked, "unknown_numbers": unknown, "bad_refs": bad_refs,
            "ok": not unknown and not bad_refs}
