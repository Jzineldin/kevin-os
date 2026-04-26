'use client';

/**
 * UserMenu — 22×22 accent-gradient avatar (monogram "K") that triggers a
 * shadcn DropdownMenu with "Logout". Logout POSTs /api/auth/logout and then
 * client-navigates to /login (cookie cleared server-side; router.push
 * triggers middleware re-check which will now redirect correctly).
 *
 * Per 03-UI-SPEC §Topbar "right: user avatar (22×22, initial 'K' on accent
 * gradient)".
 */
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function UserMenu({ initial = 'K' }: { initial?: string }) {
  const router = useRouter();

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Swallow — even if the request fails the subsequent router.push
      // will hit middleware, which will redirect to /login when the cookie
      // mismatches the bearer secret.
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open user menu"
          data-slot="user-menu-trigger"
          data-testid="topbar-user-menu"
          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-surface-1)]"
          style={{
            background:
              'linear-gradient(135deg, var(--color-accent), var(--color-accent-2))',
          }}
        >
          {initial}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[160px]">
        <DropdownMenuItem onSelect={handleLogout}>
          <LogOut className="size-3.5" />
          <span>Logout</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
