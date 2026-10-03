"""Разбор текстового транскрипта «[мм:сс] Менеджер: текст» в сегменты, как их отдаёт STT с диаризацией."""
import re

LINE = re.compile(r"^\s*(?:\[(\d{1,2}):(\d{2})(?::(\d{2}))?\])?\s*([^:]{1,20}):\s*(.+?)\s*$")
SPEAKERS = {"менеджер": "manager", "manager": "manager", "м": "manager", "оператор": "manager",
            "клиент": "customer", "customer": "customer", "к": "customer", "покупатель": "customer"}


def parse_transcript(text: str) -> list[dict]:
    segments: list[dict] = []
    for raw in text.splitlines():
        m = LINE.match(raw)
        if not m:
            if raw.strip() and segments:  # перенос строки внутри реплики
                segments[-1]["text"] += " " + raw.strip()
            continue
        a, b, c, who, said = m.groups()
        speaker = SPEAKERS.get(who.strip().lower())
        if speaker is None:
            if segments:
                segments[-1]["text"] += " " + raw.strip()
            continue
        if a is not None:
            start = int(a) * 3600 + int(b) * 60 + int(c) if c else int(a) * 60 + int(b)
        else:
            start = segments[-1]["start"] + 5 if segments else 0
        segments.append({"speaker": speaker, "start": float(start), "end": float(start), "text": said})
    for i, seg in enumerate(segments):
        nxt = segments[i + 1]["start"] if i + 1 < len(segments) else seg["start"] + 5
        seg["end"] = max(seg["start"], nxt)
    return segments
