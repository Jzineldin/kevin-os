/**
 * /login — unauthenticated entry point. v4 visual.
 *
 * Server Component shell. Renders a centered card with the v4
 * BrandMark (32px), the LoginForm client island, and install help
 * copy.
 *
 * Must be `dynamic = 'force-dynamic'` so Next doesn't prerender it and
 * cache stale CSRF context.
 */
import { Suspense } from 'react';
import { BrandMark } from '@/components/app-shell/BrandMark';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: 'var(--color-bg)' }}
    >
      <div
        className="w-full max-w-[420px] rounded-[var(--radius-lg)] border p-8"
        style={{
          background: 'var(--color-surface-1)',
          borderColor: 'var(--color-border)',
          boxShadow: '0 10px 40px -20px rgba(0,0,0,0.6)',
        }}
      >
        <div className="mb-6 flex items-center justify-center gap-3">
          <BrandMark size={32} />
          <span
            className="text-[16px] font-semibold tracking-[-0.01em]"
            style={{ color: 'var(--color-text)' }}
          >
            Kevin OS
          </span>
        </div>

        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>

        <p
          className="mt-6 text-center"
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--color-text-3)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.02em',
          }}
        >
          iOS — add to home screen via Safari&apos;s Share menu.
          <br />
          Chrome / Edge — install via the address-bar icon after sign-in.
        </p>
      </div>
    </main>
  );
}
