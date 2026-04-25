/**
 * AGT-04 loadContext azureSearch wiring (gap closure 06-07).
 *
 * Static-analysis test catching the wiring drift Plan 06-05 missed: the
 * entity-resolver handler (specifically completeDisambigOrInbox) must
 * import hybridQuery from @kos/azure-search AND pass an azureSearch
 * callable to loadContext that projects HybridQueryResult.hits (NOT
 * .results — the VERIFICATION.md prose typo).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('AGT-04 loadContext azureSearch wiring (gap closure 06-07)', () => {
  const handlerPath = resolve(__dirname, '../src/handler.ts');
  const src = readFileSync(handlerPath, 'utf8');

  it('imports hybridQuery from @kos/azure-search', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bhybridQuery\b[^}]*\}\s*from\s*['"]@kos\/azure-search['"]/,
    );
  });

  it('passes azureSearch callable to loadContext', () => {
    expect(src).toMatch(/azureSearch\s*:/);
  });

  it('projects HybridQueryResult.hits (not .results) into SearchHit[]', () => {
    expect(src).toMatch(/hybridQuery\([^)]*\)\.then\(\([^)]*\)\s*=>\s*[^)]*\.hits\)/);
  });
});
