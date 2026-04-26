/**
 * Brand-voice loader (Plan 08-02 Task 2; D-25 fail-closed gate).
 *
 * Loads `.planning/brand/BRAND_VOICE.md` once at module scope and parses the
 * YAML frontmatter. The body of the file (everything after the closing `---`)
 * becomes the `<brand_voice>` cache_control: ephemeral block injected into
 * every Sonnet 4.6 system prompt by `runContentWriterAgent`.
 *
 * The `human_verification: true` frontmatter flag is the structural Approve
 * gate for content drafting — until Kevin has reviewed and replaced the
 * placeholder voice examples in BRAND_VOICE.md, the orchestrator must NOT
 * produce drafts. `getBrandVoice()` therefore throws fail-closed when the
 * flag is `false` (or absent — conservative interpretation matching D-25
 * Test 3).
 *
 * Bundling note:
 *   - In Lambda the file is bundled into the worker via the esbuild
 *     `--loader:.md=text` switch wired by Plan 08-00's package.json build
 *     script. The bundle inlines BRAND_VOICE.md as a string constant; this
 *     module's `readFileSync` path is followed only at unit-test time.
 *   - In Vitest runs the path resolves relative to this file:
 *       services/content-writer-platform/src/brand-voice.ts
 *         → ../../../.planning/brand/BRAND_VOICE.md
 *   - The cached parsed result is reset between tests via
 *     `__resetBrandVoiceCacheForTests()`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve BRAND_VOICE.md relative to this source file. The repo layout is:
 *   <repo-root>/services/content-writer-platform/src/brand-voice.ts
 *   <repo-root>/.planning/brand/BRAND_VOICE.md
 */
const BRAND_VOICE_PATH = path.resolve(
  __dirname,
  '../../../.planning/brand/BRAND_VOICE.md',
);

let cachedMarkdown: string | null = null;
let cachedVerified: boolean | null = null;

export interface BrandVoiceParsed {
  human_verification: boolean;
  markdown_body: string;
}

/**
 * Parse a raw BRAND_VOICE.md string into the verification flag + body.
 *
 * Conservative semantics:
 *   - No frontmatter at all → human_verification=false, body=whole-file.
 *   - Frontmatter without an explicit `human_verification: true` line →
 *     human_verification=false. (Test 3.)
 *   - `human_verification: true` literal → human_verification=true.
 *     (Quoted forms like `"true"` are also accepted; anything else is
 *     treated as false.)
 */
export function parseBrandVoice(raw: string): BrandVoiceParsed {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { human_verification: false, markdown_body: raw };
  }
  const fm = match[1] ?? '';
  const body = match[2] ?? '';
  const verified = /^\s*human_verification:\s*"?true"?\s*$/m.test(fm);
  return { human_verification: verified, markdown_body: body };
}

/**
 * Load BRAND_VOICE.md from disk (or the inlined bundle string) and return
 * the markdown body suitable for prompt injection. Throws fail-closed when
 * the file's frontmatter has `human_verification: false` (or no flag at
 * all) — see CONTEXT D-25.
 *
 * Cached on success: subsequent calls within the same warm Lambda hand back
 * the same string without re-reading the file.
 */
export function getBrandVoice(): string {
  if (cachedMarkdown !== null && cachedVerified !== null) {
    if (!cachedVerified) {
      throw new Error(
        'BRAND_VOICE.md has human_verification: false — Kevin must fill in real voice before content-writer can draft. See D-25 in 08-CONTEXT.md.',
      );
    }
    return cachedMarkdown;
  }
  const raw = readFileSync(BRAND_VOICE_PATH, 'utf8');
  const parsed = parseBrandVoice(raw);
  cachedMarkdown = parsed.markdown_body;
  cachedVerified = parsed.human_verification;
  if (!parsed.human_verification) {
    throw new Error(
      'BRAND_VOICE.md has human_verification: false — Kevin must fill in real voice before content-writer can draft. See D-25 in 08-CONTEXT.md.',
    );
  }
  return parsed.markdown_body;
}

/** Test-only helper: reset the module-scope cache between tests. */
export function __resetBrandVoiceCacheForTests(): void {
  cachedMarkdown = null;
  cachedVerified = null;
}
