/**
 * /login — unauthenticated entry point.
 *
 * Server Component shell. Renders the brand mark + LoginForm client
 * island + iOS / Chrome install help text (verbatim from UI-SPEC §
 * Copywriting per D-32).
 *
 * Must be `dynamic = 'force-dynamic'` so Next doesn't prerender it and
 * cache stale CSRF context.
 */
import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ background: 'var(--color-bg)' }}
    >
      <div
        className="w-[420px] p-8 rounded-xl border"
        style={{
          background: 'var(--color-surface-1)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="flex items-center justify-center mb-6">
          <div
            aria-hidden
            className="w-[22px] h-[22px] rounded-md"
            style={{
              background:
                'linear-gradient(135deg, var(--color-accent), var(--color-accent-2))',
            }}
          />
          <span
            className="ml-2 font-semibold"
            style={{ fontSize: 'var(--text-md)', color: 'var(--color-text)' }}
          >
            Kevin OS
          </span>
        </div>

        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>

        <p
          className="mt-6"
          style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-3)' }}
        >
          iOS users: add this page to home screen via Safari&apos;s Share menu.
          Chrome / Edge: install via the address-bar icon after sign-in.
        </p>
      </div>
    </main>
  );
}
