import type { Integrations } from './api.js';

/**
 * The three Ollama states Settings renders, as one pure function.
 *
 * THREE states, not two, and the middle one is the whole point. "Reachable" and "usable" are
 * different things: an Ollama that answers `/api/tags` while the model it would actually use
 * isn't pulled used to render a plain green tick over completely dead AI features. `unusable`
 * is that middle state, and every AI surface gates on `ready` — never on `available`.
 *
 * Pulled out of the JSX because the same three-way choice drove an icon colour, a status
 * glyph and a description string as three separate inline ternaries, so a change could
 * update one and not the others — and because nothing pinned any of it. The view keeps the
 * markup; this owns the decision.
 */
export type OllamaHealth = 'ready' | 'unusable' | 'down';

/**
 * `down` while the resource is still loading or errored — fail-closed, the same rule
 * `aiAvailable()` follows in the store, so AI controls stay hidden rather than dangling as
 * no-ops before the first read lands.
 *
 * `ready` falls back to `available` only when the server omitted `ready` entirely (an older
 * server than this client). A server that sends `ready: false` is believed.
 */
export function ollamaHealth(integrations: Integrations | undefined): OllamaHealth {
  const o = integrations?.ollama;
  if (!o?.available) return 'down';
  return (o.ready ?? o.available) ? 'ready' : 'unusable';
}

/**
 * The line under the "Ollama" heading. Returns the text only — the view owns styling.
 *
 * The `unusable` case NAMES the missing models, because "AI features are off" without saying
 * which model to pull is the same dead end as the green-tick-over-nothing it replaced.
 */
export function ollamaHealthDescription(integrations: Integrations | undefined): string {
  const o = integrations?.ollama;
  switch (ollamaHealth(integrations)) {
    case 'down':
      return 'Unavailable — start Ollama on localhost:11434';
    case 'unusable': {
      const missing = o?.missingModels ?? [];
      return missing.length
        ? `Running, but ${missing.join(', ')} not installed — AI features are off`
        : 'Running, but the selected models are not installed — AI features are off';
    }
    case 'ready':
      return `${o?.models.length ?? 0} models · fast: ${o?.fastModel} · quality: ${o?.qualityModel}`;
  }
}
