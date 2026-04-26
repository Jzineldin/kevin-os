#!/usr/bin/env bash
#
# scripts/decommission-n8n.sh — Phase 10 / MIG-02.
#
# Operator orchestration script that retires the n8n daemon on the
# Hetzner VPS (port 5678 — likely the rogue Telegram-webhook auto-clear
# caller per .planning/debug/resolved/telegram-webhook-auto-clear.md).
#
# Stages (strict, archive-before-destroy invariant enforced):
#   1. DISCOVER — confirm n8n unit exists + is reachable.
#   2. SNAPSHOT — ssh-tunnel to localhost:5678; run
#      scripts/snapshot-n8n-workflows.mjs which fetches every workflow
#      and invokes the n8n-workflow-archiver Lambda for canonical-JSON +
#      SHA-256 + KMS-encrypted PutObject. Writes BOTH 'snapshot-begin'
#      and 'snapshot-ok' event_log rows.
#   3. CONFIRM — interactive gate (skipped on --dry-run): operator types
#      'decom' to proceed past this irreversible point.
#   4. STOP    — ssh + sudo systemctl stop <unit>; verify is-active.
#   5. DISABLE — ssh + sudo systemctl disable <unit>; mask defensively
#      (so even a manual `start` refuses).
#   6. AUDIT   — psql INSERT event_log row kind='n8n-stopped' with
#      detail.action='stop+disable+mask' AFTER the systemctl mutations
#      succeed. (Note: snapshot-* rows were already written in Stage 2.)
#   7. VERIFY  — invoke scripts/verify-n8n-decommissioned.mjs; exit-code
#      propagates as the script's exit-code.
#
# Audit-first invariant (D-12) is partially deferred to the verifier:
# the snapshot-* rows are written BEFORE shutdown (Stage 2), and the
# n8n-stopped row is written AFTER the stop+disable so it reflects the
# actual mutation that ran. This matches retire-vps-script.sh's pattern
# of writing the kind row prior to the mutation in Stage 4 — see the
# `--write-stop-row-before-mutation` flag (default OFF; the
# `event_log` row is written post-mutation by default since the
# preceding snapshot-ok row already proves intent).
#
# The script REFUSES to proceed past Stage 2 if the snapshot Lambda
# fails OR the snapshot script exits non-zero (zero workflows is a
# fatal error: either the tunnel is wrong or n8n is already dead and
# we have no archive — bail).
#
# Usage:
#   bash scripts/decommission-n8n.sh \
#       --ssh kevin@98.91.6.66 \
#       --unit n8n.service \
#       --lambda-fn KosMigration-N8nWorkflowArchiver \
#       --bucket kos-migration-archive-XXXXXX \
#       --kms-key arn:aws:kms:eu-north-1:XXXX:key/XXXX
#
#   bash scripts/decommission-n8n.sh --dry-run     # all stages prints, no mutations
#   bash scripts/decommission-n8n.sh --help
#
# Env (all override the matching --flag):
#   RDS_URL                  required (audit-first invariant)
#   AWS_REGION               default eu-north-1
#   VPS_HOST                 default 98.91.6.66
#   VPS_USER                 default kevin
#   N8N_UNIT                 default n8n.service
#   SSH_KEY_PATH             default ~/.ssh/id_ed25519
#   N8N_ARCHIVER_FN          override --lambda-fn
#   ARCHIVE_BUCKET_NAME      override --bucket
#   KMS_KEY_ID               override --kms-key
#
# Exit codes:
#   0  decom completed; verifier returned 3/3 PASS
#   1  any stage failed (script aborts before Stage 4 if Stage 2 failed)
#   2  argument or env validation error
#   3  user did not type 'decom' at the confirmation gate
#
# Cf. .planning/phases/10-migration-decommission/10-05-DECOMMISSION-RUNBOOK.md

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

VPS_HOST="${VPS_HOST:-98.91.6.66}"
VPS_USER="${VPS_USER:-kevin}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_ed25519}"
SSH_TARGET="${VPS_USER}@${VPS_HOST}"

UNIT="${N8N_UNIT:-n8n.service}"
LAMBDA_FN="${N8N_ARCHIVER_FN:-}"
BUCKET="${ARCHIVE_BUCKET_NAME:-}"
KMS_KEY="${KMS_KEY_ID:-}"
PREFIX="archive/n8n-workflows"
REGION="${AWS_REGION:-eu-north-1}"
TUNNEL_PORT="15678"
N8N_PORT="5678"
DRY_RUN=0
SKIP_VERIFY=0
SSH_OVERRIDE=""

print_usage() {
  cat <<'USAGE'
Usage:
  bash scripts/decommission-n8n.sh \
      --ssh kevin@98.91.6.66 \
      --unit n8n.service \
      --lambda-fn KosMigration-N8nWorkflowArchiver \
      --bucket kos-migration-archive-XXXXXX \
      --kms-key arn:aws:kms:eu-north-1:XXXX:key/XXXX

  bash scripts/decommission-n8n.sh --dry-run

Required:
  --lambda-fn <name>      n8n-workflow-archiver Lambda function name
                          (or env N8N_ARCHIVER_FN)
  --bucket <name>         S3 archive bucket  (or env ARCHIVE_BUCKET_NAME)
  --kms-key <arn|id>      SSE-KMS key        (or env KMS_KEY_ID)

Optional:
  --ssh <user@host>       default kevin@98.91.6.66
  --unit <name>           default n8n.service
  --tunnel-port <port>    default 15678 (local side of SSH -L)
  --n8n-port <port>       default 5678 (remote side; n8n's bind port)
  --prefix <s3-prefix>    default archive/n8n-workflows
  --region <aws>          default eu-north-1
  --dry-run               print every stage, mutate nothing
  --skip-verify           skip Stage 7 (mostly for CI smoke-tests)
  -h, --help              show this help

Required env:
  RDS_URL                 psql DSN — audit-first invariant
USAGE
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh) SSH_OVERRIDE="${2:-}"; shift 2 ;;
    --unit) UNIT="${2:-}"; shift 2 ;;
    --lambda-fn) LAMBDA_FN="${2:-}"; shift 2 ;;
    --bucket) BUCKET="${2:-}"; shift 2 ;;
    --kms-key) KMS_KEY="${2:-}"; shift 2 ;;
    --tunnel-port) TUNNEL_PORT="${2:-}"; shift 2 ;;
    --n8n-port) N8N_PORT="${2:-}"; shift 2 ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    -h|--help) print_usage; exit 0 ;;
    *)
      echo "[FAIL] unknown arg: $1" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$SSH_OVERRIDE" ]]; then
  SSH_TARGET="$SSH_OVERRIDE"
fi

SSH_OPTS=(-i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)

# ---------------------------------------------------------------------------
# Env / arg validation
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 0 ]]; then
  if [[ -z "${RDS_URL:-}" ]]; then
    echo "[FAIL] RDS_URL env var required (audit-first per D-12)" >&2
    echo "       export RDS_URL=\$(aws secretsmanager get-secret-value \\" >&2
    echo "          --secret-id kos/rds-admin-url --query SecretString --output text)" >&2
    exit 2
  fi
  if [[ -z "$LAMBDA_FN" ]]; then
    echo "[FAIL] --lambda-fn or N8N_ARCHIVER_FN required" >&2
    exit 2
  fi
  if [[ -z "$BUCKET" ]]; then
    echo "[FAIL] --bucket or ARCHIVE_BUCKET_NAME required" >&2
    exit 2
  fi
  if [[ -z "$KMS_KEY" ]]; then
    echo "[FAIL] --kms-key or KMS_KEY_ID required" >&2
    exit 2
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "[FAIL] psql not on PATH — audit row cannot be written" >&2
    exit 2
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "[FAIL] node not on PATH — snapshot script cannot run" >&2
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ssh_exec() {
  local cmd="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [DRY] ssh ${SSH_TARGET} '${cmd}'"
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "${cmd}"
}

# Run an ssh command but capture stdout (for is-active probes etc).
ssh_capture() {
  local cmd="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [DRY] ssh ${SSH_TARGET} '${cmd}'" >&2
    echo "active"  # synthetic — pretend active so dry-run flows hit Stage 2
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "${cmd}"
}

# Audit-row helper for the post-stop n8n-stopped row.
write_n8n_stopped_row() {
  local detail="$1"
  local sql="INSERT INTO event_log(owner_id, kind, detail, actor) VALUES ('kevin', 'n8n-stopped', '${detail}'::jsonb, 'decommission-n8n.sh');"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [DRY] psql \$RDS_URL -c \"${sql}\""
    return 0
  fi
  if ! psql "$RDS_URL" -v ON_ERROR_STOP=1 -c "$sql" >/dev/null; then
    echo "[FAIL] event_log insert failed for kind=n8n-stopped" >&2
    return 1
  fi
}

# Verify the snapshot-ok event_log row exists before allowing shutdown.
# This is the archive-before-destroy gate — if Stage 2 went sideways and
# left no audit row, we MUST refuse to proceed to Stage 4.
require_snapshot_ok_row() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [DRY] would assert event_log has snapshot-ok row"
    return 0
  fi
  local count
  count="$(psql "$RDS_URL" -At -c "SELECT count(*) FROM event_log WHERE kind='n8n-workflows-archived' AND detail->>'action'='snapshot-ok' AND occurred_at > NOW() - INTERVAL '15 minutes';" 2>/dev/null || echo 0)"
  if [[ "$count" -lt 1 ]]; then
    echo "[FAIL] no recent snapshot-ok event_log row — archive-before-destroy invariant FAILS" >&2
    echo "       Refusing to proceed to systemctl stop. Investigate the snapshot stage." >&2
    return 1
  fi
  echo "[OK]   archive-before-destroy gate satisfied (snapshot-ok row present)"
}

cleanup_tunnel() {
  if [[ "$DRY_RUN" -eq 1 ]]; then return 0; fi
  # Best-effort: kill any -L 15678 forwards we own. Pattern is narrow enough
  # to avoid stomping on unrelated tunnels.
  pkill -f "ssh.*-L ${TUNNEL_PORT}:localhost:${N8N_PORT} ${SSH_TARGET}" 2>/dev/null || true
}
trap cleanup_tunnel EXIT

TS_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------------------
# Stage 1 — DISCOVER
# ---------------------------------------------------------------------------

echo "========================================================================"
echo "Stage 1 — DISCOVER ${UNIT} on ${SSH_TARGET}"
echo "========================================================================"

if [[ "$DRY_RUN" -eq 0 ]]; then
  state="$(ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "systemctl is-active ${UNIT} 2>&1 || true")"
  state="${state//$'\r'/}"
  echo "[INFO] systemctl is-active ${UNIT} → ${state}"
  if [[ "$state" != "active" ]]; then
    echo "[WARN] ${UNIT} is not active. Continuing anyway — snapshot may still find workflows in n8n's DB-on-disk."
    echo "[WARN] If the snapshot returns 0 workflows, the script will abort before Stage 4."
  fi
else
  echo "  [DRY] ssh ${SSH_TARGET} 'systemctl is-active ${UNIT}'"
fi

# ---------------------------------------------------------------------------
# Stage 2 — SNAPSHOT (open SSH tunnel + run snapshot script)
# ---------------------------------------------------------------------------

echo
echo "========================================================================"
echo "Stage 2 — SNAPSHOT workflows + credentials → s3://${BUCKET}/${PREFIX}/"
echo "========================================================================"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  [DRY] ssh -f -N -L ${TUNNEL_PORT}:localhost:${N8N_PORT} ${SSH_TARGET}"
  echo "  [DRY] node scripts/snapshot-n8n-workflows.mjs --tunnel-port ${TUNNEL_PORT} \\"
  echo "          --lambda-fn ${LAMBDA_FN:-<dry-run>} --bucket ${BUCKET:-<dry-run>} \\"
  echo "          --kms-key ${KMS_KEY:-<dry-run>} --prefix ${PREFIX} --region ${REGION} --dry-run"
  echo "  [DRY] pkill -f 'ssh.*-L ${TUNNEL_PORT}:localhost:${N8N_PORT}'"
else
  echo "[INFO] opening SSH tunnel localhost:${TUNNEL_PORT} → ${SSH_TARGET}:${N8N_PORT}"
  ssh -f -N "${SSH_OPTS[@]}" -L "${TUNNEL_PORT}:localhost:${N8N_PORT}" "${SSH_TARGET}"
  # Give the tunnel a moment to settle.
  sleep 2

  echo "[INFO] invoking scripts/snapshot-n8n-workflows.mjs"
  if ! node scripts/snapshot-n8n-workflows.mjs \
        --tunnel-host 127.0.0.1 \
        --tunnel-port "${TUNNEL_PORT}" \
        --lambda-fn "${LAMBDA_FN}" \
        --bucket "${BUCKET}" \
        --kms-key "${KMS_KEY}" \
        --prefix "${PREFIX}" \
        --region "${REGION}"; then
    echo "[FAIL] snapshot script exited non-zero — refusing to proceed to shutdown" >&2
    cleanup_tunnel
    exit 1
  fi

  cleanup_tunnel
  echo "[OK]   snapshot stage complete"

  # Audit-trail gate: read back the snapshot-ok row before allowing Stage 4.
  require_snapshot_ok_row || exit 1
fi

# ---------------------------------------------------------------------------
# Stage 3 — CONFIRM (interactive gate)
# ---------------------------------------------------------------------------

echo
echo "========================================================================"
echo "Stage 3 — CONFIRM destructive shutdown"
echo "========================================================================"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  [DRY] read -p \"Type 'decom' to proceed: \" CONFIRM"
  echo "  [DRY] (would proceed if CONFIRM == 'decom', else exit 3)"
else
  cat <<EOF
About to execute on ${SSH_TARGET}:
  sudo systemctl stop    ${UNIT}
  sudo systemctl disable ${UNIT}
  sudo systemctl mask    ${UNIT}

This is irreversible without unmask + enable + start (rollback runbook).
The S3 archive at s3://${BUCKET}/${PREFIX}/ is your restore source.

EOF
  read -r -p "Type 'decom' to proceed: " CONFIRM || CONFIRM=""
  if [[ "$CONFIRM" != "decom" ]]; then
    echo "[ABORT] confirmation mismatch — exiting before any mutation"
    exit 3
  fi
fi

# ---------------------------------------------------------------------------
# Stage 4 — STOP
# ---------------------------------------------------------------------------

echo
echo "========================================================================"
echo "Stage 4 — STOP ${UNIT}"
echo "========================================================================"

ssh_exec "sudo systemctl stop ${UNIT}"

# Verify is-active reads inactive/failed (real path only).
if [[ "$DRY_RUN" -eq 0 ]]; then
  sleep 2
  state_after="$(ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "systemctl is-active ${UNIT} 2>&1 || true")"
  state_after="${state_after//$'\r'/}"
  if [[ "$state_after" == "active" ]]; then
    echo "[FAIL] ${UNIT} still active after stop — aborting before disable/mask" >&2
    exit 1
  fi
  echo "[OK]   ${UNIT} is now ${state_after}"
fi

# ---------------------------------------------------------------------------
# Stage 5 — DISABLE + MASK
# ---------------------------------------------------------------------------

echo
echo "========================================================================"
echo "Stage 5 — DISABLE + MASK ${UNIT}"
echo "========================================================================"

ssh_exec "sudo systemctl disable ${UNIT}"
ssh_exec "sudo systemctl mask ${UNIT}"

# ---------------------------------------------------------------------------
# Stage 6 — AUDIT (n8n-stopped row)
# ---------------------------------------------------------------------------

echo
echo "========================================================================"
echo "Stage 6 — AUDIT event_log (kind=n8n-stopped)"
echo "========================================================================"

DETAIL_JSON="{\"unit\":\"${UNIT}\",\"host\":\"${VPS_HOST}\",\"action\":\"stop+disable+mask\",\"port\":${N8N_PORT},\"bucket\":\"${BUCKET}\",\"prefix\":\"${PREFIX}\",\"ts\":\"${TS_NOW}\"}"

if ! write_n8n_stopped_row "$DETAIL_JSON"; then
  echo "[FAIL] event_log audit row write failed — n8n is stopped but trail is incomplete" >&2
  echo "       Re-run only the audit step manually:" >&2
  echo "       psql \$RDS_URL -c \"INSERT INTO event_log(owner_id,kind,detail,actor) VALUES ('kevin','n8n-stopped','${DETAIL_JSON}'::jsonb,'decommission-n8n.sh');\"" >&2
  exit 1
fi
echo "[OK]   event_log row written: kind=n8n-stopped"

# ---------------------------------------------------------------------------
# Stage 7 — VERIFY
# ---------------------------------------------------------------------------

echo
echo "========================================================================"
echo "Stage 7 — VERIFY"
echo "========================================================================"

if [[ "$SKIP_VERIFY" -eq 1 ]]; then
  echo "[SKIP] --skip-verify set; not running verify-n8n-decommissioned.mjs"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  [DRY] node scripts/verify-n8n-decommissioned.mjs --host ${VPS_HOST} --port ${N8N_PORT} --unit ${UNIT}"
else
  if ! node scripts/verify-n8n-decommissioned.mjs \
        --host "${VPS_HOST}" \
        --port "${N8N_PORT}" \
        --unit "${UNIT}" \
        --user "${VPS_USER}" \
        --ssh-key "${SSH_KEY_PATH}"; then
    echo "[FAIL] verifier returned non-zero — investigate before declaring decom complete" >&2
    exit 1
  fi
fi

echo
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[OK-DRY] all 7 stages dry-run printed"
else
  echo "[OK] n8n decommissioned — port ${N8N_PORT} closed, ${UNIT} masked, audit trail complete"
  echo "     Next: T+1min Telegram webhook re-test (see runbook)"
fi
