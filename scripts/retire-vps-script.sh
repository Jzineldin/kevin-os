#!/usr/bin/env bash
#
# scripts/retire-vps-script.sh — Phase 10 / MIG-01 / INF-11.
#
# Generic systemd-unit retirement tool used by Phase 10 Waves 1, 3, 4 to:
#   1. Stop a unit on the Hetzner VPS (98.91.6.66 by default).
#   2. systemd-disable it (no auto-start on reboot).
#   3. systemd-mask it (defensive — even manual `systemctl start` refuses).
#   4. Capture the last 50 lines of journalctl into
#      .planning/phases/10-migration-decommission/retirement-logs/<unit>-<ts>.log
#   5. Write an `event_log` audit row with kind 'vps-service-stopped' or
#      'vps-service-disabled' BEFORE the systemctl mutation (D-12 audit-first).
#
# The `--undo` flag reverses steps 1-3 (unmask, enable, start) and emits
# another `event_log` row whose `detail.action='restored'` so the same kind
# enum (vps-service-disabled — already in @kos/contracts EventLogKindSchema)
# carries the restore audit without requiring a contract change.
#
# Usage:
#   bash scripts/retire-vps-script.sh \
#       --unit morning_briefing.service \
#       --replaced-by kos-morning-brief
#
#   bash scripts/retire-vps-script.sh \
#       --unit morning_briefing.service \
#       --replaced-by kos-morning-brief \
#       --dry-run
#
#   bash scripts/retire-vps-script.sh --undo --unit morning_briefing.service
#
# Required env:
#   RDS_URL            psql DSN to the KOS RDS instance (Secrets Manager
#                      lookup recommended; see runbook `pre-retirement` step).
#   SSH_KEY_PATH       optional; defaults to ~/.ssh/id_ed25519.
#
# Exit codes:
#   0  retired (or undone) cleanly
#   1  audit insert failed → no systemctl mutation performed
#   2  unit already in target state and --strict not set
#   3  argument validation error
#
# Safety invariants:
#   - audit-first: psql INSERT runs BEFORE any ssh-side systemctl call.
#     If the audit insert fails the script exits 1 BEFORE touching the VPS.
#   - dry-run is a no-op against the VPS AND against RDS (prints intended
#     SSH + SQL commands and exits 0).
#   - mask is applied LAST so an aborted run leaves the unit recoverable
#     via `systemctl unmask` (Phase 1 freeze rollback floor preserved).
#
# Cf. .planning/phases/10-migration-decommission/10-02-RETIREMENT-RUNBOOK.md
# for the operator-facing T-0 + T+2h + rollback sequence.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults + arg parsing
# ---------------------------------------------------------------------------

VPS_HOST="${VPS_HOST:-98.91.6.66}"
VPS_USER="${VPS_USER:-kevin}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_ed25519}"
SSH_TARGET="${VPS_USER}@${VPS_HOST}"

UNIT=""
REPLACED_BY=""
DRY_RUN=0
UNDO=0
STRICT=0
SSH_OVERRIDE=""

print_usage() {
  cat <<'USAGE'
Usage:
  bash scripts/retire-vps-script.sh --unit <name> --replaced-by <replacement> [--dry-run] [--ssh user@host]
  bash scripts/retire-vps-script.sh --undo --unit <name> [--ssh user@host]

Required:
  --unit <name>            systemd unit name (e.g. morning_briefing.service)
  --replaced-by <id>       Lambda / Scheduler id that replaces this unit
                           (NOT required with --undo).

Optional:
  --dry-run                print SSH+SQL commands; no mutations
  --undo                   reverse: unmask + enable + start + audit row
  --ssh <user@host>        override target host (default kevin@98.91.6.66)
  --strict                 fail if unit is already in target state
  -h, --help               show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)
      UNIT="${2:-}"; shift 2 ;;
    --replaced-by)
      REPLACED_BY="${2:-}"; shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    --undo)
      UNDO=1; shift ;;
    --ssh)
      SSH_OVERRIDE="${2:-}"; shift 2 ;;
    --strict)
      STRICT=1; shift ;;
    -h|--help)
      print_usage; exit 0 ;;
    *)
      echo "[FAIL] unknown arg: $1" >&2
      print_usage >&2
      exit 3
      ;;
  esac
done

if [[ -z "$UNIT" ]]; then
  echo "[FAIL] --unit is required" >&2
  print_usage >&2
  exit 3
fi
if [[ "$UNDO" -eq 0 && -z "$REPLACED_BY" ]]; then
  echo "[FAIL] --replaced-by is required (omit only with --undo)" >&2
  exit 3
fi

if [[ -n "$SSH_OVERRIDE" ]]; then
  SSH_TARGET="$SSH_OVERRIDE"
fi

SSH_OPTS=(-i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

# ---------------------------------------------------------------------------
# Audit-first: validate RDS_URL is set and psql works
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 0 ]]; then
  if [[ -z "${RDS_URL:-}" ]]; then
    echo "[FAIL] RDS_URL env var is required (audit-first per D-12)" >&2
    echo "       export RDS_URL=\$(aws secretsmanager get-secret-value --secret-id kos/rds-admin-url --query SecretString --output text)" >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "[FAIL] psql not on PATH — audit row cannot be written" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TS_NOW="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR=".planning/phases/10-migration-decommission/retirement-logs"

ssh_exec() {
  # ssh into VPS_TARGET and run a remote command. Echoes when --dry-run.
  local cmd="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [DRY] ssh ${SSH_TARGET} '${cmd}'"
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "${cmd}"
}

write_audit_row() {
  # write_audit_row <kind> <detail-json>
  local kind="$1"
  local detail="$2"
  local sql="INSERT INTO event_log(kind, detail, actor) VALUES ('${kind}', '${detail}'::jsonb, 'retire-vps-script.sh');"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [DRY] psql \$RDS_URL -c \"${sql}\""
    return 0
  fi
  if ! psql "$RDS_URL" -v ON_ERROR_STOP=1 -c "$sql" >/dev/null; then
    echo "[FAIL] event_log insert failed for kind=${kind} unit=${UNIT}" >&2
    return 1
  fi
}

is_active() {
  # Returns 0 if active, 1 otherwise (matches systemctl is-active semantics).
  local state
  state="$(ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "systemctl is-active ${UNIT} || true" 2>/dev/null || echo unknown)"
  state="${state//$'\r'/}"
  [[ "$state" == "active" ]]
}

# ---------------------------------------------------------------------------
# UNDO path
# ---------------------------------------------------------------------------

if [[ "$UNDO" -eq 1 ]]; then
  echo "[INFO] UNDO mode — restoring ${UNIT} on ${SSH_TARGET}"
  detail_json="{\"unit\":\"${UNIT}\",\"host\":\"${VPS_HOST}\",\"action\":\"restored\",\"ts\":\"${TS_NOW}\"}"

  # audit-first
  write_audit_row "vps-service-disabled" "$detail_json" || exit 1

  ssh_exec "sudo systemctl unmask ${UNIT}"
  ssh_exec "sudo systemctl enable ${UNIT}"
  ssh_exec "sudo systemctl start ${UNIT}"

  if [[ "$DRY_RUN" -eq 0 ]]; then
    sleep 2
    if is_active; then
      echo "[OK]  restored ${UNIT} — unit is active"
    else
      echo "[WARN] ${UNIT} restore succeeded at systemd level but is not active yet" >&2
    fi
  else
    echo "[OK-DRY] would have restored ${UNIT}"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# RETIRE path (default)
# ---------------------------------------------------------------------------

echo "[INFO] retire ${UNIT} on ${SSH_TARGET} — replaced_by=${REPLACED_BY}"

# Audit row BEFORE any systemctl mutation (D-12).
detail_json="{\"unit\":\"${UNIT}\",\"replaced_by\":\"${REPLACED_BY}\",\"host\":\"${VPS_HOST}\",\"action\":\"stop+disable+mask\",\"ts\":\"${TS_NOW}\"}"
write_audit_row "vps-service-stopped" "$detail_json" || exit 1
write_audit_row "vps-service-disabled" "$detail_json" || exit 1

# Pre-check: is the unit active?
if [[ "$DRY_RUN" -eq 0 ]]; then
  if is_active; then
    SKIP_STOP=0
  else
    echo "[WARN] ${UNIT} already inactive — skipping systemctl stop"
    SKIP_STOP=1
    if [[ "$STRICT" -eq 1 ]]; then
      echo "[FAIL] --strict set; refusing to retire an already-inactive unit" >&2
      exit 2
    fi
  fi
else
  SKIP_STOP=0
fi

# Stop
if [[ "${SKIP_STOP:-0}" -eq 0 ]]; then
  ssh_exec "sudo systemctl stop ${UNIT}"
fi

# Verify stop took effect (real path only)
if [[ "$DRY_RUN" -eq 0 && "${SKIP_STOP:-0}" -eq 0 ]]; then
  sleep 1
  if is_active; then
    echo "[FAIL] ${UNIT} still active after stop — aborting before disable/mask" >&2
    exit 1
  fi
fi

# Disable
ssh_exec "sudo systemctl disable ${UNIT}"

# Mask (defensive — even manual start refuses)
ssh_exec "sudo systemctl mask ${UNIT}"

# Capture last 50 lines of journalctl for forensic record
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/${UNIT//\//_}-${TS_NOW}.log"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  [DRY] ssh ${SSH_TARGET} 'sudo journalctl -u ${UNIT} -n 50 --no-pager' > ${LOG_FILE}"
else
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "sudo journalctl -u ${UNIT} -n 50 --no-pager" > "$LOG_FILE" 2>/dev/null || {
    echo "[WARN] journalctl capture failed; log file not written" >&2
  }
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[OK-DRY] would have retired ${UNIT} — replaced by ${REPLACED_BY}"
else
  echo "[OK]  retired ${UNIT} — replaced by ${REPLACED_BY}"
  echo "      journal log: ${LOG_FILE}"
fi
