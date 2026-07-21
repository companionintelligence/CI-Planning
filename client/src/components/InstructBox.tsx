import { createSignal, For, Show } from 'solid-js';
import { api } from '../lib/api.js';
import { aiAvailable, refetchBlocks, showToast } from '../stores/index.js';
import { MicButton } from './MicButton.js';
import type { BranchProps } from './PlanWeekAssistant.js';

/**
 * InstructBox (#387) — the free-text natural-language instruction surface for the
 * Plan-my-week assistant's action branches (Fill's confirm step, Schedule's question
 * step). "block off Tuesday mornings for deep work" → a readable preview of exactly
 * what was understood → an explicit Apply.
 *
 * PREVIEW → CONFIRM, never apply-on-submit (owner ruling): submit calls the
 * parse-only twin `POST /plan-week/parse` (zero writes — the route runs
 * `parseInstruction` directly), and only the Apply button calls
 * `POST /plan/instruct`, which inserts each pin as a LOCKED obstacle block
 * (`source_kind='instruct'`) and persists hints for the next autoplan run. Both
 * routes share the same parser, so the preview IS the apply semantics.
 *
 * The apply reuses the preview's exact (text, date) — editing the input after a
 * parse does NOT change what Apply applies; it only feeds the next parse.
 *
 * Errors surface the server's own message (specific 422s: overlapping pins, bad
 * HH:MM, unknown tag, "No actionable constraints found"; or the 503 unavailable
 * copy) — `request()` throws `Error(err.error)`, so `err.message` is that string.
 *
 * TRUTHFULNESS (the T9 rule): `reportAiUse` fires only on what the server actually
 * did — a successful parse or apply IS model usage (`parseInstruction` is
 * `generateJson`-backed and throws `unavailable` otherwise). Never gated on
 * `aiAvailable()` alone; that flag only decides whether the box renders at all
 * (parsing needs Ollama — same gate as the assistant's other AI affordances).
 */

interface Preview {
  text: string;
  date: string;
  pins: { title: string; start_at: string; end_at: string }[];
  hints: { kind: string; tag: string; time?: string }[];
}

const fmtLocal = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function InstructBox(props: {
  date: () => string;
  append: BranchProps['append'];
  reportAiUse: () => void;
}) {
  const [text, setText] = createSignal('');
  const [busy, setBusy] = createSignal<'parse' | 'apply' | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const parse = () => {
    const value = text().trim();
    if (!value || busy()) return;
    setError(null);
    setBusy('parse');
    const date = props.date();
    void api.planWeek
      .parse(value, date)
      .then((res) => {
        // Clear busy BEFORE the preview renders — with a .finally() the Apply button
        // would paint one microtask before the guard drops, and a click in that window
        // (a fast tap, or a test's MutationObserver-driven findByText) silently no-ops
        // against the busy() check.
        setBusy(null);
        // Keep the REQUEST date, not the echo — Apply must send the same pair the
        // preview was computed for.
        setPreview({ text: value, date, pins: res.pins, hints: res.hints });
        props.reportAiUse(); // a successful parse is model usage (see header)
        void props.append(
          `Understood "${value}" → ${res.pins.length} pin(s), ${res.hints.length} hint(s)`,
          'plan_week:instruct_preview',
        );
      })
      .catch((err: Error) => {
        setBusy(null);
        setError(err.message);
      });
  };

  const apply = () => {
    const p = preview();
    if (!p || busy()) return;
    setError(null);
    setBusy('apply');
    void api.plan
      .instruct(p.text, p.date)
      .then((res) => {
        setBusy(null); // before the re-render, same reasoning as parse's
        props.reportAiUse();
        void props.append(
          `Applied: ${res.pins.length} pin(s), ${res.hints.length} hint(s) (AI)`,
          'plan_week:instruct_apply',
        );
        showToast(`Applied — ${res.created} pinned block(s), ${res.hints.length} hint(s)`, 'success');
        refetchBlocks(); // pins are real locked calendar blocks
        setPreview(null);
        setText('');
      })
      .catch((err: Error) => {
        setBusy(null);
        setError(err.message);
      });
  };

  const discard = () => {
    setPreview(null);
    setError(null);
  };

  return (
    <Show when={aiAvailable()}>
      <div class="flex flex-col gap-2 border-t border-border/60 pt-3">
        <p class="text-[11px] text-muted-foreground">
          Anything to block off or arrange? e.g. “block off Tuesday mornings for deep work”
        </p>
        {/* T14 (#350): talk as well as type — the transcript lands in the same text
            state and feeds the same parse; MicButton renders nothing when the browser
            has no SpeechRecognition, so typing is always the degrade path. */}
        <div class="relative">
          <input
            class="input text-sm w-full pr-9"
            placeholder="Describe a constraint…"
            value={text()}
            disabled={busy() !== null}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') parse(); }}
          />
          <div class="absolute right-1.5 top-1/2 -translate-y-1/2">
            <MicButton
              onTranscript={(t) => { setText(t); parse(); }}
              onError={(r) => setError(r)}
              disabled={busy() !== null}
              class="btn-icon p-1"
            />
          </div>
        </div>
        <Show when={error()}>
          <p class="text-xs text-destructive">{error()}</p>
        </Show>

        <Show when={preview()}>
          {(p) => (
            <div class="flex flex-col gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs">
              <span class="text-muted-foreground">I understood:</span>
              <For each={p().pins}>
                {(pin) => <span>Pin · {pin.title} · {fmtLocal(pin.start_at)}–{fmtLocal(pin.end_at)}</span>}
              </For>
              <For each={p().hints}>
                {(h) => <span>Hint · {h.kind.replace('_', ' ')} #{h.tag}{h.time ? ` @ ${h.time}` : ''}</span>}
              </For>
              <div class="flex gap-2 mt-1">
                <button type="button" class="btn-primary text-xs" disabled={busy() !== null} onClick={apply}>
                  {busy() === 'apply' ? 'Applying…' : 'Apply'}
                </button>
                <button type="button" class="btn-ghost text-xs" disabled={busy() !== null} onClick={discard}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
