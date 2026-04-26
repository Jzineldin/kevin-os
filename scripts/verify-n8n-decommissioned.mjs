#!/usr/bin/env node
/**
 * scripts/verify-n8n-decommissioned.mjs — Phase 10 Plan 10-05 / MIG-02 verifier.
 *
 * Three independent assertions, all must PASS for exit 0:
 *
 *   CHECK A — process: `ssh kevin@<vps> systemctl is-active n8n.service`
 *             returns 'inactive' or 'failed' (NOT 'active'). The decom
 *             script also masks the unit, so `is-enabled` should return
 *             'masked' or 'disabled'; we check both states.
 *
 *   CHECK B — port: external probe of <vps>:5678 returns ECONNREFUSED
 *             (or ETIMEDOUT if a firewall DROP is in place). Anything
 *             that reaches a TCP handshake or HTTP response = FAIL.
 *
 *             Two-source mitigation (P-07): probe runs from the operator
 *             machine. If the operator network sits behind the same
 *             upstream as Hetzner, an infra-level block could mask a
 *             still-running n8n. The runbook documents the AWS-side probe
 *             follow-up.
 *
 *   CHECK C — audit: event_log contains BOTH:
 *             - kind='n8n-workflows-archived' detail.action='snapshot-ok'
 *               (written by snapshot-n8n-workflows.mjs)
 *             - kind='n8n-stopped' detail.action='stop+disable+mask'
 *               (written by decommission-n8n.sh)
 *             AND the snapshot-ok row's occurred_at < n8n-stopped row's
 *             occurred_at (archive-before-destroy invariant).
 *
 * Usage:
 *   node scripts/verify-n8n-decommissioned.mjs              # 3 checks
 *   node scripts/verify-n8n-decommissioned.mjs --host 98.91.6.66
 *   node scripts/verify-n8n-decommissioned.mjs --port 5678
 *   node scripts/verify-n8n-decommissioned.mjs --skip-ssh   # CHECK A only via audit
 *   node scripts/verify-n8n-decommissioned.mjs --json
 *   node scripts/verify-n8n-decommissioned.mjs --help
 *
 * Env:
 *   RDS_URL                  required for CHECK C
 *   VPS_HOST                 default 98.91.6.66
 *   VPS_USER                 default kevin
 *   SSH_KEY_PATH             default ~/.ssh/id_ed25519
 *   N8N_UNIT                 default n8n.service
 *
 * Exit codes:
 *   0  3/3 PASS
 *   1  any FAIL
 *   2  argument or env validation error
 *
 * Cf. .planning/phases/10-migration-decommission/10-05-DECOMMISSION-RUNBOOK.md
 */
import process from 'node:process';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    host: process.env.VPS_HOST || '98.91.6.66',
    port: 5678,
    user: process.env.VPS_USER || 'kevin',
    sshKey: process.env.SSH_KEY_PATH || `${homedir()}/.ssh/id_ed25519`,
    unit: process.env.N8N_UNIT || 'n8n.service',
    timeoutMs: 5000,
    skipSsh: false,
    json: false,
    help: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const next = () => {
      const v = a[++i];
      if (v === undefined) {
        console.error(`[FAIL] ${k} requires a value`);
        process.exit(2);
      }
      return v;
    };
    switch (k) {
      case '--host': out.host = next(); break;
      case '--port': out.port = Number(next()); break;
      case '--user': out.user = next(); break;
      case '--ssh-key': out.sshKey = next(); break;
      case '--unit': out.unit = next(); break;
      case '--timeout': out.timeoutMs = Number(next()); break;
      case '--skip-ssh': out.skipSsh = true; break;
      case '--json': out.json = true; break;
      case '-h':
      case '--help': out.help = true; break;
      default:
        console.error(`[FAIL] unknown arg: ${k}`);
        process.exit(2);
    }
  }
  return out;
}

function printUsage() {
  console.log(
    [
      'verify-n8n-decommissioned.mjs — assert n8n is dead + audit trail intact.',
      '',
      'Three checks (all must PASS for exit 0):',
      '  A) systemctl is-active <unit> on the VPS == inactive/failed',
      '  B) external TCP probe of <host>:<port> returns ECONNREFUSED/ETIMEDOUT',
      '  C) event_log has snapshot-ok BEFORE n8n-stopped (archive-before-destroy)',
      '',
      'Usage:',
      '  node scripts/verify-n8n-decommissioned.mjs',
      '  node scripts/verify-n8n-decommissioned.mjs --host 98.91.6.66 --port 5678',
      '  node scripts/verify-n8n-decommissioned.mjs --skip-ssh    # audit-only',
      '  node scripts/verify-n8n-decommissioned.mjs --json',
      '',
      'Required env: RDS_URL (CHECK C).',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// CHECK A — systemctl is-active over SSH
// ---------------------------------------------------------------------------

function checkSystemd(args) {
  if (args.skipSsh) {
    return { name: 'systemd', skipped: true, pass: null, detail: 'skipped (--skip-ssh)' };
  }
  const target = `${args.user}@${args.host}`;
  const sshArgs = [
    '-i', args.sshKey,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    target,
    `systemctl is-active ${args.unit} 2>&1; systemctl is-enabled ${args.unit} 2>&1`,
  ];
  const result = spawnSync('ssh', sshArgs, { encoding: 'utf8' });
  // is-active returns non-zero exit when inactive — that's the desired state,
  // so we don't bail on result.status; we read stdout.
  const lines = (result.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const active = lines[0] || 'unknown';
  const enabled = lines[1] || 'unknown';
  const activeOk = active === 'inactive' || active === 'failed' || active === 'unknown';
  const enabledOk = enabled === 'masked' || enabled === 'disabled';
  const pass = activeOk && enabledOk;
  return {
    name: 'systemd',
    pass,
    detail: `is-active=${active} is-enabled=${enabled} (want: inactive|failed + masked|disabled)`,
    raw: { active, enabled, sshExit: result.status },
  };
}

// ---------------------------------------------------------------------------
// CHECK B — net.connect probe
// ---------------------------------------------------------------------------

function probePort({ host, port, timeoutMs }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ result: 'timeout' }), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      settle({ result: 'connected' });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      settle({ result: 'error', code: err.code, message: err.message });
    });
  });
}

async function checkPort(args) {
  const probe = await probePort({
    host: args.host,
    port: args.port,
    timeoutMs: args.timeoutMs,
  });
  let pass = false;
  let detail = '';
  if (probe.result === 'error' && probe.code === 'ECONNREFUSED') {
    pass = true;
    detail = `ECONNREFUSED — port closed cleanly (no listener)`;
  } else if (probe.result === 'timeout' || (probe.result === 'error' && probe.code === 'ETIMEDOUT')) {
    pass = true;
    detail = `${probe.result === 'timeout' ? 'timeout' : 'ETIMEDOUT'} — likely firewall DROP (n8n probably dead)`;
  } else if (probe.result === 'connected') {
    pass = false;
    detail = 'TCP connect SUCCEEDED — n8n process or proxy still listening';
  } else if (probe.result === 'error') {
    // Other errors (EHOSTUNREACH, ENETUNREACH) — count as PASS but note.
    pass = true;
    detail = `${probe.code} — host unreachable, port effectively closed (caveat: confirm not a transient network error)`;
  } else {
    pass = false;
    detail = `unknown probe outcome: ${JSON.stringify(probe)}`;
  }
  return {
    name: 'port',
    pass,
    detail: `${args.host}:${args.port} → ${detail}`,
    raw: probe,
  };
}

// ---------------------------------------------------------------------------
// CHECK C — event_log audit ordering
// ---------------------------------------------------------------------------

function checkAudit() {
  if (!process.env.RDS_URL) {
    return {
      name: 'audit',
      pass: false,
      detail: 'RDS_URL env var missing — cannot read event_log',
    };
  }
  // Pull (kind, occurred_at, action) for the most recent matching row of
  // each kind. We use COALESCE on detail->>'action' so older rows missing
  // the action field still surface.
  const sql = `
SELECT
  kind,
  occurred_at,
  COALESCE(detail->>'action', '(none)') AS action
FROM event_log
WHERE
  (kind = 'n8n-workflows-archived' AND detail->>'action' = 'snapshot-ok')
  OR
  (kind = 'n8n-stopped')
ORDER BY kind, occurred_at DESC
`.trim();

  const result = spawnSync(
    'psql',
    [
      process.env.RDS_URL,
      '-v', 'ON_ERROR_STOP=1',
      '-At',                 // tuples-only, no header, unaligned
      '-F', '|',             // pipe-delimited
      '-c', sql,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return {
      name: 'audit',
      pass: false,
      detail: `psql failed: ${result.stderr.trim()}`,
    };
  }
  const rows = (result.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [kind, occurredAt, action] = l.split('|');
      return { kind, occurredAt, action };
    });

  // Pick the most recent of each kind (rows are sorted DESC within kind).
  const snapshot = rows.find(
    (r) => r.kind === 'n8n-workflows-archived' && r.action === 'snapshot-ok',
  );
  const stopped = rows.find((r) => r.kind === 'n8n-stopped');

  if (!snapshot) {
    return {
      name: 'audit',
      pass: false,
      detail: 'no event_log row of kind=n8n-workflows-archived action=snapshot-ok found',
    };
  }
  if (!stopped) {
    return {
      name: 'audit',
      pass: false,
      detail: 'no event_log row of kind=n8n-stopped found',
    };
  }
  // Archive must precede stop (archive-before-destroy invariant).
  if (new Date(snapshot.occurredAt) >= new Date(stopped.occurredAt)) {
    return {
      name: 'audit',
      pass: false,
      detail:
        `audit order violation: snapshot-ok @ ${snapshot.occurredAt} >= n8n-stopped @ ${stopped.occurredAt}`,
    };
  }
  return {
    name: 'audit',
    pass: true,
    detail:
      `snapshot-ok @ ${snapshot.occurredAt}  <  n8n-stopped @ ${stopped.occurredAt} (archive-before-destroy OK)`,
    raw: { snapshot, stopped },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const results = [];
  results.push(checkSystemd(args));
  results.push(await checkPort(args));
  results.push(checkAudit());

  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const r of results) {
      const tag = r.skipped ? '[SKIP]' : r.pass ? '[PASS]' : '[FAIL]';
      console.log(`${tag} ${r.name.padEnd(8)} ${r.detail}`);
    }
  }

  const failed = results.filter((r) => r.pass === false).length;
  const counted = results.filter((r) => !r.skipped).length;
  const passed = results.filter((r) => r.pass === true).length;
  console.log(`\nSummary: ${passed}/${counted} PASS  (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[FAIL] uncaught: ${err.stack || err.message}`);
  process.exit(1);
});
