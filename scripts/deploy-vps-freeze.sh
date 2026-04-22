#!/usr/bin/env bash
#
# Deploy the VPS soft-freeze (D-14).
#
# Steps:
#   1. Back up current VPS scripts to /opt/kos-vps/original/ (first-time only)
#      so revert is a single `cp` away.
#   2. Rsync the patched scripts from services/vps-freeze-patched/ onto the VPS.
#   3. Write /etc/kos-freeze.env containing LEGACY_INBOX_DB_ID (pulled from
#      scripts/.notion-db-ids.json). NOTION_TOKEN is expected to already be
#      present in the VPS's existing process env — we do NOT overwrite it.
#   4. Reload systemd + restart the three timer-driven services. Unit names
#      vary by VPS provisioning (A6); try both candidate name sets and log
#      which one worked.
#
# Requires:
#   - SSH key already authorized for kevin@98.91.6.66
#   - jq installed locally
#   - scripts/.notion-db-ids.json populated with legacyInbox UUID
set -euo pipefail

VPS=${VPS_HOST:-98.91.6.66}
USER=${VPS_USER:-kevin}

NOTION_ID_FILE="scripts/.notion-db-ids.json"
if [ ! -f "$NOTION_ID_FILE" ]; then
  echo "[FAIL] $NOTION_ID_FILE missing. Run scripts/bootstrap-notion-dbs.mjs first." >&2
  exit 1
fi

LEGACY_INBOX_DB_ID=$(jq -r .legacyInbox "$NOTION_ID_FILE")
if [ -z "$LEGACY_INBOX_DB_ID" ] || [ "$LEGACY_INBOX_DB_ID" = "null" ] || [ "$LEGACY_INBOX_DB_ID" = "pending-bootstrap" ]; then
  echo "[FAIL] Legacy Inbox DB ID missing or not yet bootstrapped in $NOTION_ID_FILE." >&2
  exit 1
fi

echo "[1/4] Backing up originals on VPS (first-time only)..."
ssh "$USER@$VPS" "bash -s" <<'REMOTE'
set -euo pipefail
sudo mkdir -p /opt/kos-vps/original
for f in classify_and_save.py morning_briefing.py evening_checkin.py; do
  if [ -f "/opt/kos-vps/$f" ] && [ ! -f "/opt/kos-vps/original/$f" ]; then
    sudo cp "/opt/kos-vps/$f" "/opt/kos-vps/original/$f"
    echo "  backed up $f"
  else
    echo "  skip $f (already backed up or source missing)"
  fi
done
echo "backup-done"
REMOTE

echo "[2/4] Rsync-ing patched scripts..."
rsync -avz --chmod=755 services/vps-freeze-patched/ "$USER@$VPS:/opt/kos-vps/"

echo "[3/4] Writing /etc/kos-freeze.env with LEGACY_INBOX_DB_ID..."
ssh "$USER@$VPS" "sudo bash -c 'cat > /etc/kos-freeze.env <<EOF
LEGACY_INBOX_DB_ID=$LEGACY_INBOX_DB_ID
EOF
chmod 600 /etc/kos-freeze.env
chown root:root /etc/kos-freeze.env'"
echo "  wrote /etc/kos-freeze.env (NOTION_TOKEN preserved from existing VPS env)"

echo "[4/4] Reloading systemd + restarting services..."
ssh "$USER@$VPS" "bash -s" <<'REMOTE'
set -u
sudo systemctl daemon-reload
# Try the kos- prefix first (new provisioning), then fall back to plain names.
if sudo systemctl restart kos-classify kos-morning kos-evening 2>/dev/null; then
  echo "  restarted: kos-classify, kos-morning, kos-evening"
elif sudo systemctl restart classify-and-save morning-briefing evening-checkin 2>/dev/null; then
  echo "  restarted: classify-and-save, morning-briefing, evening-checkin"
else
  echo "  [WARN] systemd unit-name mismatch — neither kos-* nor classify-and-save/morning-briefing/evening-checkin restarted."
  echo "  Check actual unit names with: systemctl list-units --type=service | grep -iE 'classify|morning|evening'"
  exit 2
fi
REMOTE

echo "[OK] VPS freeze deployed (Legacy Inbox ID: ${LEGACY_INBOX_DB_ID:0:8}...)"
