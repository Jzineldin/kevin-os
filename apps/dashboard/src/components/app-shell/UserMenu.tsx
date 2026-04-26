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
          className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-full border text-[12px] font-bold text-[color:var(--color-text-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-sect-priority)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-surface-1)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)] hover:bg-[color:var(--color-surface-hover)]"
          style={{
            background: 'var(--color-surface-3)',
            borderColor: 'var(--color-border-hover)',
          }}
        >
          {initial.toUpperCase()}
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
