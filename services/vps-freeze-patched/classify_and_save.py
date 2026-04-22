#!/usr/bin/env python3
"""VPS freeze-redirected classify_and_save. D-14 soft redirect.

Writes EVERY payload to the Notion Legacy Inbox DB with [MIGRERAD] marker
(or [SKIPPAT-DUP] if the original-script dedup flag is set). Never touches
Command Center / Kontakter / Daily Brief Log — those are now owned by KOS
agents in Phase 2+.

Reversibility: originals live under /opt/kos-vps/original/ (placed there by
scripts/deploy-vps-freeze.sh before rsync overwrites). `cp
/opt/kos-vps/original/classify_and_save.py /opt/kos-vps/` + systemd restart
restores the pre-freeze behaviour.

Env (from /etc/kos-freeze.env + pre-existing VPS env):
  LEGACY_INBOX_DB_ID  — Notion DB UUID for the Legacy Inbox (Plan 04 output)
  NOTION_TOKEN        — existing Notion integration token on the VPS
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
SOURCE_NAME = "classify_and_save"


def post_legacy(title: str, payload: dict, is_dup: bool = False) -> None:
    """Upsert the payload into Notion Legacy Inbox with [MIGRERAD] marker."""
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
    # Read whatever the original script consumed from stdin/argv. During freeze
    # we don't care about the classification logic; we only need the raw
    # payload preserved in the Legacy Inbox for later reconciliation.
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {"raw": raw}

    title = payload.get("title") or payload.get("subject") or f"{SOURCE_NAME} auto-redirect"

    # Respect the dedup flag if the original script pipeline set it.
    is_dup = bool(payload.get("is_duplicate") or payload.get("already_processed"))

    post_legacy(title, payload, is_dup=is_dup)
