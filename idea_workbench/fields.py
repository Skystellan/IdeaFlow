"""Small value helpers shared by the store, journal and runner."""
from __future__ import annotations

import json
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def text_field(value, label, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f"{label} must be {'non-empty ' if required else ''}text, at most {limit} characters")
    return value.strip()
