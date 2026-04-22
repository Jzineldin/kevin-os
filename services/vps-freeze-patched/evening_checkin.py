#!/usr/bin/env python3
"""VPS freeze-redirected evening_checkin. D-14 soft redirect.

Writes to Notion Legacy Inbox with [MIGRERAD] marker. Never touches
Command Center / Kontakter. The real KOS evening-brief lives in Phase 7.
"""
import os
import json
import sys
from datetime import datetime, timezone

import requests

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
LEGACY_INBOX_DB_ID = os.environ["LEGACY_INBOX_DB_ID"]

NOTION_API_URL = "https://api.notion.com/v1/pages"
NOTION_VERSION = "2022-06-28"
SOURCE_NAME = "evening_checkin"


def post_legacy(title: str, payload: dict, is_dup: bool = False) -> None:
    marker = "[SKIPPAT-DUP]" if is_dup else "[MIGRERAD]"
    marker_title = f"{marker} {title}"
    body = {
        "parent": {"database_id": LEGACY_INBOX_DB_ID},
        "properties": {
            "Name": {"title": [{"text": {"content": marker_title[:2000]}}]},
            "Source": {"select": {"name": SOURCE_NAME}},
            "OriginalPayload": {
                "rich_text": [
                    {"text": {"content": json.dumps(payload)[:1900]}}
                ],
            },
            "CreatedAt": {
                "date": {"start": datetime.now(timezone.utc).isoformat()},
            },
            "Marker": {"rich_text": [{"text": {"content": marker}}]},
        },
    }
    resp = requests.post(
        NOTION_API_URL,
        headers={
            "Authorization": f"Bearer {NOTION_TOKEN}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
        data=json.dumps(body),
        timeout=10,
    )
    resp.raise_for_status()


if __name__ == "__main__":
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {"raw": raw}

    title = payload.get("title") or f"{SOURCE_NAME} auto-redirect {datetime.now(timezone.utc).date()}"
    is_dup = bool(payload.get("is_duplicate") or payload.get("already_processed"))

    post_legacy(title, payload, is_dup=is_dup)
