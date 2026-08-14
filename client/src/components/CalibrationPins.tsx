import { createResource, For, Show } from 'solid-js';
import { Pin, PinOff } from 'lucide-solid';
import { api } from '../lib/api.js';
import { prefs, tags, showToast } from '../stores/index.js';

/**
 * CalibrationPins (#390) — the §2.3 hybrid confirm workflow, finally operable.
 * The server detects tag-COMBO estimate biases that diverge from their component
 * tags (`detectComboSuggestions`: unpinned, ≥5 samples, ≥0.25 divergence) and
 * treats a POSTed pin as "the explicit human confirmation that persists" — but
 * until this panel no owner could ever see or act on one.
 *
 * PIN, sense 2 of 3 — a CALIBRATION COMBO PIN (`calibration_combo_pins`,
 * server/src/services/calibration.ts): the owner confirming "keep learning a separate
 * estimate bias for this tag combination". The other two pins in this codebase are an
 * operator env pin (`config.pins`, server/src/lib/config.ts) and a plan PIN — a locked
 * task start time (server/src/agents/plan.ts `PlanPin`). See ARCHITECTURE.md §Glossary.
 *
 * Sits under the Calibration-nudge toggle in Settings; NOT bound to the prefs
 * `form()` machinery (that is for pref fields) — it reads its own resource,
 * gated the standard Time-Sense way (`ElementWizard`'s idiom): master flag on
 * AND the calibration channel not explicitly off. Pin sends the suggestion's
 * ORIGINAL `tag_ids` (never a re-split of scope_ref); unpin URL-encodes the
 * '+'-joined ref. Labels resolve client-side through the `tags()` store — a
 * deleted tag's id renders as `unknown`.
 */

const mult = (n: number) => `~${n.toFixed(1)}×`;

export function CalibrationPins() {
  const gated = () => !!prefs()?.time_sense_enabled && prefs()?.calibration_loop_enabled !== false;
  const [scopes, { refetch }] = createResource(
    () => (gated() ? 'on' : null),
    () => api.calibration.scopes().catch(() => null),
  );

  const nameOf = (tagId: string) => (tags() ?? []).find((t) => t.id === tagId)?.name ?? 'unknown';
  const comboLabel = (tagIds: string[]) => tagIds.map((id) => `#${nameOf(id)}`).join(' + ');

  const pin = async (tagIds: string[]) => {
    try {
      await api.calibration.addPin(tagIds);
    } catch (err) {
      showToast((err as Error).message, 'error'); // the server's 422 copy, verbatim
    }
    void refetch();
  };

  const unpin = async (scopeRef: string) => {
    try {
      await api.calibration.removePin(scopeRef);
    } catch (err) {
      // 404 = already unpinned elsewhere — refetch quietly.
      if (!/pin not found/i.test((err as Error).message)) showToast((err as Error).message, 'error');
    }
    void refetch();
  };

  return (
    <Show when={gated() && scopes()}>
      {(s) => (
        <div class="flex flex-col gap-1.5">
          <Show
            when={s().suggestions.length > 0 || s().pins.length > 0}
            fallback={
              <p class="text-[11px] text-muted-foreground">
                No combo patterns detected yet — pins appear after ~5 completed tasks share a tag pair.
              </p>
            }
          >
            <For each={s().suggestions}>
              {(sug) => (
                <div class="flex items-center gap-2 text-[11px] rounded-md border border-border bg-background/60 px-2 py-1.5">
                  <span class="flex-1 min-w-0 truncate text-foreground">
                    {comboLabel(sug.tag_ids)}
                    <span class="text-muted-foreground">
                      {' '}· {mult(sug.combo_bias)} typical (vs {mult(sug.component_bias)} for its tags alone) · {sug.sample_count} samples
                    </span>
                  </span>
                  <button type="button" class="btn-ghost text-[11px] px-1.5 py-0.5 inline-flex items-center gap-1 flex-shrink-0" onClick={() => void pin(sug.tag_ids)}>
                    <Pin size={11} /> Pin
                  </button>
                </div>
              )}
            </For>
            <For each={s().pins}>
              {(p) => (
                <div class="flex items-center gap-2 text-[11px] rounded-md border border-border bg-background/60 px-2 py-1.5">
                  <Pin size={11} class="text-primary flex-shrink-0" />
                  <span class="flex-1 min-w-0 truncate text-foreground">{comboLabel(p.scope_ref.split('+'))}</span>
                  <button type="button" class="btn-ghost text-[11px] px-1.5 py-0.5 inline-flex items-center gap-1 flex-shrink-0" onClick={() => void unpin(p.scope_ref)}>
                    <PinOff size={11} /> Unpin
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      )}
    </Show>
  );
}
