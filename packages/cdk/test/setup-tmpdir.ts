/**
 * Redirect CDK synth temp dirs into a process-scoped subdir of /tmp
 * instead of bare /tmp. CDK's `App.synth()` uses `os.tmpdir()` by
 * default; each synth leaves a `cdk.out<random>` dir of ~70-115 MB.
 * Without this, hundreds of tests fill the host disk fast.
 *
 * Mechanism: setting `TMPDIR` env var makes Node's `os.tmpdir()`
 * return that path. We use `/tmp/kos-cdk-test-<pid>/` so:
 *   - the dir is OUTSIDE the project tree (CRITICAL — putting it
 *     inside packages/cdk caused recursive asset copies hitting
 *     ENAMETOOLONG, since CDK NodejsFunction bundling copies the
 *     workspace tree and would then re-copy its own output)
 *   - the dir is unique per test process (parallel runs don't
 *     stomp each other)
 *   - it lives in /tmp which is already ephemeral
 *   - we own teardown explicitly, so a single test run leaves
 *     ZERO `cdk.out*` artifacts behind
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DIR = join(tmpdir(), `kos-cdk-test-${process.pid}`);
const ORPHAN_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Sweep stale `kos-cdk-test-*` siblings older than 1 hour. Teardown can
 * miss a directory when vitest is killed mid-run (SIGKILL, OOM, panel
 * crash) — without this sweep, /tmp accumulates 100s of multi-GB dirs
 * and the host disk fills (verified live 2026-04-26).
 *
 * Concurrency safe: only deletes dirs older than the threshold, so a
 * still-running parallel test process is never touched.
 */
function sweepStaleSiblings(): void {
  const root = tmpdir();
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory() || !name.name.startsWith('kos-cdk-test-')) continue;
    const path = join(root, name.name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Ignore — racing teardown is fine.
    }
  }
}

export function setup(): void {
  sweepStaleSiblings();
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env['TMPDIR'] = TMP_DIR;
}

export function teardown(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
