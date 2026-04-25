// Phase 3 Plan 03-01 Task 3 — flat ESLint config for @kos/dashboard.
//
// Guards:
//   1. Raw hex literals in JSX className/style — banned per 03-UI-SPEC.md
//      Fidelity Rule 4 ("Tokens never hardcoded"). All colors come from the
//      @theme tokens in globals.css.
//   2. `dangerouslySetInnerHTML` — banned per RESEARCH §16 XSS mitigation.
//      Notion rich-text content could render attacker-crafted markup; React's
//      default escaping is the primary defence, and we refuse the escape hatch.
//   3. `import { db } from '@kos/db'` in Vercel runtime code — the Drizzle
//      client cannot reach RDS from Vercel (VPC-only); every DB read must go
//      through services/dashboard-api via SigV4 fetch.
//   4. Node-only packages inside middleware.ts — middleware runs on the Edge
//      runtime (RESEARCH P-01).
//
// Uses the legacy compat layer to pull in Next's bundled config (next/core-web-vitals)
// since eslint-config-next still ships a legacy (.eslintrc) shape.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  // Ignore build + vendor output.
  {
    ignores: [
      '.next/**',
      'out/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      '.lighthouseci/**',
      'next-env.d.ts',
      // shadcn-generated components — upstream-authored; don't enforce our
      // house rules on the primitives. Our own components/views in Wave 1+
      // that consume them ARE linted.
      'src/components/ui/**',
    ],
  },

  // TypeScript recommended (includes the JS baseline rules we care about).
  ...tseslint.configs.recommended,

  // Next.js core-web-vitals (legacy shareable → flat compat).
  ...compat.extends('next/core-web-vitals'),

  // App source — custom KOS design-system + XSS guards.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Raw hex in className attribute, e.g. className="bg-[#ff00aa]".
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/#[0-9a-fA-F]{3,8}/]",
          message:
            'Raw hex in className is banned — use @theme tokens from globals.css (03-UI-SPEC Fidelity Rule 4).',
        },
        {
          // Raw hex in className template literal, e.g. className={`bg-[${x}] #abcdef`}.
          selector:
            "JSXAttribute[name.name='className'] TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}/]",
          message:
            'Raw hex in className template is banned — use @theme tokens (03-UI-SPEC Fidelity Rule 4).',
        },
        {
          // Inline style.backgroundColor = '#...' / 'rgb(...)'.
          selector:
            "JSXAttribute[name.name='style'] ObjectExpression Property[key.name='backgroundColor']",
          message:
            'Inline backgroundColor is banned — use a Tailwind class or CSS variable.',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'dangerouslySetInnerHTML is banned — XSS risk with Notion content (RESEARCH §16).',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@kos/db',
              importNames: ['db'],
              message:
                'Do not import the Drizzle client on Vercel — it cannot reach RDS (VPC-only). Go through services/dashboard-api via SigV4 fetch.',
            },
          ],
        },
      ],
    },
  },

  // Middleware runs on the Edge runtime — forbid Node-only packages.
  {
    files: ['src/middleware.ts', 'src/middleware.{js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@kos/db', '@kos/db/*', 'pg', 'pg-*', '@aws-sdk/*'],
              message:
                'Middleware runs on Edge runtime — cannot import Node-only packages (RESEARCH P-01).',
            },
          ],
        },
      ],
    },
  },

  // Test files — relax a few rules that would otherwise fight Playwright/Vitest.
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];

export default config;
