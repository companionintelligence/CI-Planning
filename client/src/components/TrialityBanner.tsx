import { createResource, createSignal, For, Show } from 'solid-js';
import { X } from 'lucide-solid';
import { api, type TrialityPick, type TrialityNext, type TrialityConfidence, type TrialityMarginBasis } from '../lib/api.js';
import { prefs, tags, categoryPrefs, showToast, setElementModal } from '../stores/index.js';
import { colorVar } from '../lib/pattern-meta.js';

/**
 * TrialityBanner (design §9.1) — the ONE suggestion surface: a dismissable
 * banner on the Focus view. Three pills (Habitual · Contextual · Novel), the
 * score breakdown behind a tap (inline expansion, deliberately card-local and
 * read-only — the 0137 CloseRitual mount lesson: never attach flows to a node
 * a refetch can unmount), open/stage per pill, feedback stamped per action.
 *
 * v2.2 adds the confidence band ON the pill, never behind the tap — hedging
 * behind a tap is not hedging. It LABELS only: a `guess` still fills its slot,
 * and nothing here suppresses, reorders or filters a pick on a band.
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

/** The denominator the SERVER's evidence component divides by (EVIDENCE_FULL in
 *  services/triality-confidence.ts). Duplicated because the wire ships the finished
 *  ratio, never the constant. DISPLAY ONLY — nothing here re-derives a component or a
 *  band from it, so a server retune costs a stale denominator in one printed line, not a
 *  wrong badge. */
// ⚠️ TWO-SITE CONSTANT. The other site is EVIDENCE_FULL in
// server/src/services/triality-confidence.ts, and it is pinned by name in
// server/test/triality-confidence.test.ts so a server-side retune fails there with a
// message pointing back at this line. Change both in one commit, or the expansion prints
// an impossible sentence like "evidence 12 of 8".
const EVIDENCE_FULL = 8;

/** Verbatim from the design's §2. It says what the count does NOT claim, which is the
 *  part a bare "3 of 12" gets wrong: a sensed neutral and an unsensed hole are the same
 *  0 to the vector, and one active dim reaches no score at all — so this number can move
 *  while every pick stands still. */
const COVERAGE_TOOLTIP =
  'A signal counts here only when it leans one way. A quiet day and an unread day look identical to the vector. ' +
  'One of them (momentum) is sensed but nothing scores it, so this count can move without any pick moving.';
// ^ "one of them", not "one of the twelve": the denominator is 12 only when the owner has
// configured work hours and 11 when they have not, so a spelled-out count would be wrong
// for exactly the owners who never set them up. The live number is already on screen.

/** Only the two bases that mean "no comparison happened" carry a caveat. `dot` and
 *  `score` describe a comparison the number already reports, and annotating them would
 *  be narration. */
const BASIS_CAVEAT: Partial<Record<TrialityMarginBasis, string>> = {
  uncontested: ' — nothing else was eligible for this slot',
  tie: ' — a tie the id order broke; this is a coin flip',
};

/**
 * The one-line hedge behind the band marker, composed from the BINDING component — the
 * one that set the minimum. Naming any other component would be an advertisement: under
 * a weakest link the binding one is the only thing standing between this pick and a
 * higher band, and it is the only sentence the owner can do anything about.
 *
 * `uncontested` and `tie` are deliberately different sentences even though both arrive as
 * margin 0: "nothing else was eligible" is a statement about the pool, "the id order
 * decided" is a coin flip, and collapsing them would hide which one happened.
 */
function hedgeFor(p: TrialityPick, c: TrialityConfidence): string {
  if (c.binding === 'evidence') {
    const n = c.counts.evidence_rows;
    if (n === 0) {
      // A block template can never accrue a completion trail — the server's matcher
      // excludes it by construction — so "you haven't done this" would blame the owner
      // for a structural zero.
      return p.action_kind === 'template'
        ? 'saved blocks have no completion trail, so nothing backs this'
        : "you haven't done this kind of thing in the last 90 days";
    }
    return `only ${n} completion${n === 1 ? '' : 's'} of this kind in 90 days`;
  }
  if (c.binding === 'margin') {
    if (c.margin_basis === 'uncontested') return 'nothing else was eligible for this slot';
    if (c.margin_basis === 'tie') return 'tied with another candidate — the id order decided, not the evidence';
    return 'the runner-up was almost as good';
  }
  return `only ${c.counts.dims_informative} of ${c.counts.dims_active} situation signals are pointing anywhere right now`;
}

/** Composed as a string rather than inline JSX so the format is one readable line and the
 *  separators cannot drift with the markup. */
function confidenceLine(c: TrialityConfidence): string {
  return (
    `confidence ${c.value} · ${c.band} — coverage ${c.coverage} · margin ${c.margin} (${c.margin_basis})` +
    ` · evidence ${c.counts.evidence_rows} of ${EVIDENCE_FULL}${BASIS_CAVEAT[c.margin_basis] ?? ''}`
  );
}

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

  // All three picks are scored against ONE situation vector, so coverage is a
  // banner-level fact and gets printed ONCE — three copies of the same fraction would
  // read as a coincidence rather than the shared fact it is. Taken off the first pick
  // that carries a confidence rather than recounted from `next().vector`: the server
  // already did the counting the band was derived from, and a second implementation here
  // could disagree with the badge sitting next to it.
  const coverage = () => picks().find((p) => p.confidence)?.confidence ?? null;

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
                    {/* v2.2 — the band, ALWAYS visible: hedging behind a tap is not
                        hedging. `firm` renders NOTHING, deliberately — a marker on every
                        pill trains the eye to ignore all of them, and badging `firm` is
                        the app boasting about a model the calibration tile has not
                        validated yet. A guess still fills its slot; this labels, it does
                        not suppress. aria-label is required, not decoration: a bare `~`
                        is meaningless read aloud (the motivation glyph above sets the
                        precedent). */}
                    <Show when={p.confidence}>
                      <Show when={p.confidence!.band === 'tentative'}>
                        <span
                          class="text-[9px] text-muted-foreground"
                          title={hedgeFor(p, p.confidence!)}
                          aria-label={`tentative — ${hedgeFor(p, p.confidence!)}`}
                        >
                          ~
                        </span>
                      </Show>
                      <Show when={p.confidence!.band === 'guess'}>
                        <span
                          class="text-[9px] tracking-[0.1em] italic text-muted-foreground"
                          title={hedgeFor(p, p.confidence!)}
                          aria-label={`a guess — ${hedgeFor(p, p.confidence!)}`}
                        >
                          GUESS
                        </span>
                      </Show>
                    </Show>
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
                    {/* The band's own arithmetic, under the score line and above the
                        rationale: value, the three components it is the minimum of, and
                        the raw evidence count. Same contract as the line above — the
                        arithmetic IS the explanation, so every number the band was
                        derived from is printable and checkable by hand. */}
                    <Show when={p.confidence}>
                      <div class="mt-0.5 ml-2 text-[10px] text-muted-foreground" data-testid="triality-confidence">
                        {confidenceLine(p.confidence!)}
                      </div>
                    </Show>
                    {/* T9 garnish, under the arithmetic and never instead of it: the
                        line is always labeled with who wrote it (the "AI Briefing" vs
                        "Day Overview" honesty idiom). No rationale — or a rationale
                        with no source — renders NO line: an unlabeled explanation is
                        worse than none. */}
                    <Show when={p.rationale && p.rationale_source}>
                      <div class="mt-0.5 ml-2 text-[10px] text-muted-foreground" data-testid="triality-rationale">
                        <span
                          class="mr-1 rounded px-1 text-[8px] tracking-[0.1em] uppercase border border-border"
                          classList={{ 'text-accent-hi': p.rationale_source === 'ai' }}
                          title={p.rationale_source === 'ai' ? 'written by the local model' : 'deterministic explanation'}
                        >
                          {p.rationale_source === 'ai' ? 'AI' : 'template'}
                        </span>
                        {p.rationale}
                      </div>
                    </Show>
                  </Show>
                </div>
              )}
            </For>
            <Show when={picks().length === 0}>
              <span class="text-xs text-muted-foreground">Nothing fits right now.</span>
            </Show>
          </div>
          <Show when={coverage()}>
            <div class="text-[10px] text-muted-foreground mt-2" data-testid="triality-coverage" title={COVERAGE_TOOLTIP}>
              {coverage()!.counts.dims_informative} of {coverage()!.counts.dims_active} signals are pointing somewhere right now.
            </div>
          </Show>
          <div class="text-[9px] text-muted-foreground mt-2">
            candidates, not certainties · tap a pill for the arithmetic · ✕ hides this until tomorrow
          </div>
        </Show>
      </div>
    </Show>
  );
}
