'use client';

/**
 * LoginForm — client island for /login.
 *
 * UI contract (03-UI-SPEC.md §Login):
 *   - Visible label "Paste session token"
 *   - <input type="password"> (token never in React tree, form-submit only)
 *   - Primary button "Sign in" — accent fill (shadcn Button default variant)
 *   - On error: inline red text "Token rejected. Check it and try again."
 *     (verbatim per UI-SPEC §Copywriting Contract)
 *   - On success: router.push(?return=<path> ?? '/today'); router.refresh()
 *
 * The token is POSTed to /api/auth/login as JSON; the server echoes a
 * Set-Cookie with the httpOnly session. We never store the token in
 * state beyond the submit (React strips it when the component unmounts
 * after navigation).
 */
import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function LoginForm() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = params.get('return') ?? '/today';

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setError('Token rejected. Check it and try again.');
        return;
      }
      // Clear the local state before navigating so the token is not
      // retained in React's fiber tree across the route transition.
      setToken('');
      // typedRoutes is on — but `return` comes from the URL and Next
      // doesn't statically know the shape. Narrow through a cast; the
      // middleware still enforces auth on whatever path we land on.
      router.push(returnTo as Route);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label
        htmlFor="token"
        style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-2)' }}
      >
        Paste session token
      </label>
      <Input
        id="token"
        name="token"
        type="password"
        autoComplete="current-password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoFocus
        required
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? 'login-error' : undefined}
      />
      {error && (
        <p
          id="login-error"
          role="alert"
          style={{ fontSize: 'var(--text-sm)', color: 'var(--color-danger)' }}
        >
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending || token.length === 0}>
        Sign in
      </Button>
    </form>
  );
}
