import { createSignal } from 'solid-js';
import { Wand2 } from 'lucide-solid';
import { api } from '../lib/api.js';
import { selectedDay, refetchBlocks, showToast } from '../stores/index.js';

/**
 * Phase M A4 — one-line natural-language planning instruction.
 * Enter parses via /api/plan/instruct: appointment-style PINS become locked blocks the
 * deterministic placer routes around; tag/ordering HINTS are persisted and enforced on
 * the next Auto run (per-tag time windows in placement + a soft authoring constraint).
 */
export function PlanInstruct() {
  const [text, setText] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  async function run() {
    const v = text().trim();
    if (!v || busy()) return;
    setBusy(true);
    try {
      const res = await api.plan.instruct(v, selectedDay());
      setText('');
      if (res.created > 0) refetchBlocks();
      const bits: string[] = [];
      if (res.created > 0) bits.push(`${res.created} pinned`);
      if (res.hints.length > 0) bits.push(`${res.hints.length} hint${res.hints.length === 1 ? '' : 's'} applied`);
      showToast(bits.length ? `Plan: ${bits.join(' · ')}` : 'Nothing to pin', bits.length ? 'success' : 'default');
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="relative">
      <Wand2 size={15} class="absolute left-3 top-1/2 -translate-y-1/2 text-primary pointer-events-none" />
      <input
        class="input-lg pl-9"
        placeholder="Tell the planner… e.g. 'dentist 2–3pm, batch #email'"
        value={text()}
        disabled={busy()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && run()}
      />
    </div>
  );
}
