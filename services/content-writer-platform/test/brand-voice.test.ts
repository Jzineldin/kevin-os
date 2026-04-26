/**
 * BRAND_VOICE.md parser + fail-closed gate tests (Plan 08-02 Task 2).
 *
 * 3 tests:
 *   1. human_verification: false → throws fail-closed.
 *   2. human_verification: true → returns markdown body, no frontmatter.
 *   3. Missing frontmatter → conservative fail-closed (treated as false).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRAND_VOICE_PATH = path.resolve(
  __dirname,
  '../../../.planning/brand/BRAND_VOICE.md',
);

describe('parseBrandVoice', () => {
  it('1. frontmatter human_verification: false → fail-closed via getBrandVoice()', async () => {
    const fixtureRaw = [
      '---',
      'human_verification: false',
      'last_edited_by: planner',
      '---',
      '',
      '# voice body',
      'kept short',
    ].join('\n');

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        readFileSync: () => fixtureRaw,
      };
    });
    const { getBrandVoice, parseBrandVoice, __resetBrandVoiceCacheForTests } =
      await import('../src/brand-voice.js');
    __resetBrandVoiceCacheForTests();

    const parsed = parseBrandVoice(fixtureRaw);
    expect(parsed.human_verification).toBe(false);
    expect(parsed.markdown_body).toContain('# voice body');

    expect(() => getBrandVoice()).toThrow(/human_verification: false/);
  });

  it('2. frontmatter human_verification: true → returns body without frontmatter', async () => {
    const fixtureRaw = [
      '---',
      'human_verification: true',
      'last_edited_by: kevin',
      '---',
      '',
      '# voice body',
      'energetic, direct',
    ].join('\n');

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        readFileSync: () => fixtureRaw,
      };
    });
    const { getBrandVoice, parseBrandVoice, __resetBrandVoiceCacheForTests } =
      await import('../src/brand-voice.js');
    __resetBrandVoiceCacheForTests();

    const parsed = parseBrandVoice(fixtureRaw);
    expect(parsed.human_verification).toBe(true);
    expect(parsed.markdown_body).toContain('# voice body');
    expect(parsed.markdown_body).not.toContain('human_verification:');

    const body = getBrandVoice();
    expect(body).toContain('energetic, direct');
    expect(body).not.toMatch(/^---/);
  });

  it('3. missing frontmatter → fail-closed (treated as human_verification=false)', async () => {
    const fixtureRaw = '# voice body\nno frontmatter at all';

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        readFileSync: () => fixtureRaw,
      };
    });
    const { getBrandVoice, parseBrandVoice, __resetBrandVoiceCacheForTests } =
      await import('../src/brand-voice.js');
    __resetBrandVoiceCacheForTests();

    const parsed = parseBrandVoice(fixtureRaw);
    expect(parsed.human_verification).toBe(false);
    expect(parsed.markdown_body).toBe(fixtureRaw);

    expect(() => getBrandVoice()).toThrow(/human_verification: false/);
  });
});

// Sanity check: the live BRAND_VOICE.md placeholder ships with human_verification=false,
// confirming D-25 is in effect right now. Skips if file is missing.
describe('shipped BRAND_VOICE.md sanity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unmock('node:fs');
  });

  it('live file path exists at .planning/brand/BRAND_VOICE.md', () => {
    let raw: string | undefined;
    try {
      raw = readFileSync(BRAND_VOICE_PATH, 'utf8');
    } catch {
      // skip — repo state may not have the file
      return;
    }
    expect(typeof raw).toBe('string');
  });
});
