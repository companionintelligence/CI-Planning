import { AlertTriangle } from 'lucide-solid';

/**
 * The app mounts a single root ErrorBoundary in the shell (App.tsx). This is its
 * fallback: a view whose render threw — most often a `createResource` read that hit a
 * 403/500 — degrades to this recoverable panel instead of white-screening the whole SPA.
 * The shell chrome (nav, top bar) stays mounted around it.
 *
 * "Try again" calls the boundary's `reset` (re-runs the failed render — useful when the
 * error was transient). "Reload" is the hard escape hatch.
 */
export function ErrorBoundaryFallback(props: { error: unknown; onReset: () => void }) {
  const message = () => {
    const e = props.error;
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    return 'Something went wrong.';
  };

  return (
    <div class="min-h-full flex items-center justify-center bg-surface-950 text-muted-foreground p-6">
      <div class="max-w-md w-full flex flex-col items-center text-center gap-4">
        <AlertTriangle size={28} class="text-amber-400" />
        <div class="space-y-1">
          <p class="text-sm font-heading text-slate-100">This view hit an error</p>
          <p class="text-xs text-muted-foreground break-words">{message()}</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            onClick={() => props.onReset()}
            class="px-3 py-1 rounded-full text-xs bg-primary text-primary-foreground transition-colors"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            class="px-3 py-1 rounded-full text-xs border border-surface-700/60 text-muted-foreground hover:text-foreground transition-colors"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
