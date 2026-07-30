import { createResource, createSignal, For, Show } from 'solid-js';
import { X } from 'lucide-solid';
import { api, type TrialityPick, type TrialityNext } from '../lib/api.js';
import { prefs, tags, categoryPrefs, showToast, setElementModal } from '../stores/index.js';
import { colorVar } from '../lib/pattern-meta.js';

/**
 * TrialityBanner (design §9.1) — the ONE suggestion surface: a dismissable
 * banner on the Focus view. Three pills (Habitual · Contextual · Novel), the
 * score breakdown behind a tap (inline expansion, deliberately card-local and
 * read-only — the 0137 CloseRitual mount lesson: never attach flows to a node
 * a refetch can unmount), open/stage per pill, feedback stamped per action.
 *
 * Dismissal is BANNER-level (owner ruling, no per-pill ✕): the ✕ stamps
 * `dismissed` on every still-unactioned shown row, then collapses until the
 * next owner-local day via a localStorage date key. Per-device on purpose in
 * v1 — a dismissal is a mood, not data worth syncing.
 */

const DISMISS_KEY = 'triality_banner_dismissed';

/** Owner-local YYYY-MM-DD from the prefs timezone (browser tz as the fallback —
 *  the same safety net the app's first-load tz adoption uses). */
function ownerToday(): string {
  const tz = prefs()?.timezone || undefined;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  }
}

const SLOT_LABEL: Record<string, string> = { habitual: 'HABITUAL', contextual: 'CONTEXTUAL', novel: 'NOVEL' };
const MOTIVATION_GLYPH: Record<string, { glyph: string; title: string }> = {
  me: { glyph: '●', title: 'for me' },
  us: { glyph: '◐', title: 'for us' },
  them: { glyph: '○', title: 'for them' },
};

export function TrialityBanner() {
  const enabled = () => !!prefs()?.triality_enabled;
  const [dismissedDate, setDismissedDate] = createSignal(localStorage.getItem(DISMISS_KEY));
  const collapsed = () => dismissedDate() === ownerToday();

  // Fetch ONLY when the flag is on and today isn't dismissed — a collapsed
  // banner must not fire requests (a shown row it can't show would be a lie
  // in the learning corpus).
  const [next] = createResource(
    () => (enabled() && !collapsed() ? ownerToday() : null),
    () => api.triality.next().catch(() => null),
  );

  // Pills the user acted on this render — excluded from the ✕ dismissal stamps
  // (their outcome already landed; a second stamp would no-op server-side anyway,
  // but not asking is cleaner than relying on the guard).
  const [acted, setActed] = createSignal<Set<string>>(new Set());
  const [expanded, setExpanded] = createSignal<string | null>(null);

  const picks = () => (next()?.picks ?? []).filter((p): p is TrialityPick => !!p);

  function stamp(logId: string | null, outcome: 'opened' | 'staged' | 'dismissed') {
    if (!logId) return;
    setActed((s) => new Set(s).add(logId));
    void api.triality.feedback(logId, outcome).catch(() => {/* feedback is best-effort */});
  }

  function openPick(p: TrialityPick) {
    stamp(p.log_id, 'opened');
    // Tasks (incl. flight-staged ones) open in the wizard; routines/templates have
    // no single-entity editor to open into — their pills are stage/inspect only.
    if (p.action_kind === 'task' || p.action_kind === 'flight') {
      setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: p.action_ref } });
    }
  }

  async function stagePick(p: TrialityPick) {
    try {
      await api.flightPlan.addTask(p.action_ref);
      stamp(p.log_id, 'staged');
      showToast('Staged in flight plan', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  function dismissBanner() {
    for (const p of picks()) {
      if (p.log_id && !acted().has(p.log_id)) stamp(p.log_id, 'dismissed');
    }
    localStorage.setItem(DISMISS_KEY, ownerToday());
    setDismissedDate(ownerToday());
  }

  // First category's hue, via tag_prefs (the six Balance-dimension colours live
  // there, NOT on the tag row — the ElementWizard picker's exact source).
  const swatch = (p: TrialityPick) => {
    const name = p.categories[0];
    if (!name) return null;
    const tag = (tags() ?? []).find((t) => t.kind === 'category' && t.name.toLowerCase() === name);
    if (!tag) return null;
    return colorVar(categoryPrefs()?.prefs?.[tag.id]?.color_token);
  };

  const refusal = () => {
    const n = next() as TrialityNext | null | undefined;
    return n?.refused ? n : null;
  };

  return (
    <Show when={enabled() && !collapsed() && next()}>
      <div class="mb-5 rounded-2xl border border-border border-l-2 border-l-accent-hi bg-card p-3.5" data-testid="triality-banner">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] font-semibold uppercase tracking-[0.15em] text-accent-hi">What's next</span>
          <button class="btn-icon" title="Dismiss for today" aria-label="Dismiss suggestions for today" onClick={dismissBanner}>
            <X size={13} />
          </button>
        </div>

        <Show
          when={!refusal()}
          fallback={
            <div class="text-xs text-muted-foreground">
              Not enough history yet ({refusal()!.have} of {refusal()!.need} reflected completions).
            </div>
          }
        >
          <div class="flex flex-wrap gap-2">
            <For each={picks()}>
              {(p) => (
                <div class="flex flex-col">
                  <div
                    class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-foreground cursor-pointer"
                    classList={{ 'border-accent-hi/50': p.slot === 'contextual', 'border-border': p.slot !== 'contextual' }}
                    onClick={() => setExpanded(expanded() === p.log_id ? null : p.log_id)}
                    title="Tap for the arithmetic"
                  >
                    <Show when={swatch(p)}>
                      <span class="w-2 h-2 rounded-sm flex-shrink-0" style={{ 'background-color': swatch(p)! }} />
                    </Show>
                    <span class="truncate max-w-[180px]">{p.title}</span>
                    <Show when={p.motivation && MOTIVATION_GLYPH[p.motivation]}>
                      <span class="text-accent-hi" title={MOTIVATION_GLYPH[p.motivation!].title} aria-label={MOTIVATION_GLYPH[p.motivation!].title}>
                        {MOTIVATION_GLYPH[p.motivation!].glyph}
                      </span>
                    </Show>
                    <span class="text-[9px] tracking-[0.1em] text-muted-foreground">{SLOT_LABEL[p.slot]}</span>
                    <Show when={p.action_kind === 'task' || p.action_kind === 'flight'}>
                      <button
                        class="text-accent-hi hover:underline"
                        onClick={(e) => { e.stopPropagation(); openPick(p); }}
                      >
                        open
                      </button>
                    </Show>
                    <Show when={p.action_kind === 'task'}>
                      <button
                        class="text-accent-hi hover:underline"
                        onClick={(e) => { e.stopPropagation(); void stagePick(p); }}
                      >
                        stage
                      </button>
                    </Show>
                  </div>
                  <Show when={expanded() === p.log_id}>
                    <div class="mt-1 ml-2 text-[10px] text-muted-foreground" data-testid="triality-breakdown">
                      F {p.scores.F} · H {p.scores.H} · Q {p.scores.Q} · N {p.scores.N} · C {p.scores.C} ·
                      <span class="text-foreground font-medium"> S {p.scores.total}</span>
                      <span> · [{p.ternary.join(', ')}]</span>
                    </div>
                  </Show>
                </div>
              )}
            </For>
            <Show when={picks().length === 0}>
              <span class="text-xs text-muted-foreground">Nothing fits right now.</span>
            </Show>
          </div>
          <div class="text-[9px] text-muted-foreground mt-2">
            candidates, not certainties · tap a pill for the arithmetic · ✕ hides this until tomorrow
          </div>
        </Show>
      </div>
    </Show>
  );
}
