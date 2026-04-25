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
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DIR = join(tmpdir(), `kos-cdk-test-${process.pid}`);

export function setup(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env['TMPDIR'] = TMP_DIR;
}

export function teardown(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
