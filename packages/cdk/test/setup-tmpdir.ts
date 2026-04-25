/**
 * Redirect CDK synth temp dirs into a project-local `.cdk-tmp/` instead
 * of the OS `/tmp`. CDK's `App.synth()` uses `os.tmpdir()` by default
 * which on this dev EC2 fills up the root disk fast (each synth run
 * leaves a `cdk.out<random>` dir of ~70-115 MB).
 *
 * Mechanism: setting `TMPDIR` env var before any CDK code runs makes
 * Node's `os.tmpdir()` return that path instead of `/tmp`.
 *
 * The dir is created if missing and wiped clean before each run so
 * stale synth outputs from prior runs don't accumulate either.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const TMP_DIR = resolve(__dirname, '../.cdk-tmp');

export function setup(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env['TMPDIR'] = TMP_DIR;
}

export function teardown(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
