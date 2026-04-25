/**
 * /offline — static fallback shown by the service worker when a navigation
 * request cannot be served from cache or network (Plan 03-12 Task 1).
 *
 * Intentionally tiny: no client JS, no network calls, no data dependencies.
 * Copy tone matches 03-UI-SPEC §Copywriting (calm, short, no retry button —
 * reconnection is automatic, browsers retry navigation on their own).
 */
export const metadata = {
  title: 'Offline · Kevin OS',
};

export default function OfflinePage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[color:var(--color-bg)] p-8 text-center">
      <div className="max-w-sm">
        <h1 className="text-[22px] font-semibold tracking-tight text-[color:var(--color-text)]">
          Offline
        </h1>
        <p className="mt-2 text-[13px] text-[color:var(--color-text-3)]">
          You&apos;re offline. Open Today to see your last synced view.
        </p>
      </div>
    </main>
  );
}
