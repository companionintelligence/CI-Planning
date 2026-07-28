/**
 * Which Ollama model to use for a given tier.
 *
 * Resolution order (first hit wins):
 *   1. the per-owner override picked in Settings (scheduling_prefs.fast_model /
 *      quality_model / embed_model) — an explicit user choice is never second-guessed;
 *   2. an operator env pin (OLLAMA_SMALL / OLLAMA_MEDIUM / OLLAMA_EMBED) — likewise
 *      deliberate, so it is used verbatim even if it turns out not to be installed;
 *   3. the built-in default, WHEN it is actually installed;
 *   4. otherwise a model auto-selected from what this device actually has.
 *
 * (4) is why this file grew past a two-line lookup. The built-in defaults are fixed names
 * (`qwen2.5:0.5b` / `gemma3n:e4b`) that most installs do not have, and the failure was
 * silent and badly misleading: `/api/tags` answered, so Settings reported "Ollama
 * available ✓ N models" while every inference call died with `model 'qwen2.5:0.5b' not
 * found` and each AI feature quietly degraded to its deterministic fallback. A green
 * light with nothing behind it.
 *
 * Selection is driven by Ollama's own per-model metadata rather than a hardcoded list of
 * blessed names, so it keeps working as the user pulls models we have never heard of:
 *
 *   - `embedding` capability → embedding models. Only ever used for the embed tier, and
 *     excluded from the generation tiers.
 *   - `thinking` capability → EXCLUDED from generation. Verified against a live Ollama:
 *     a thinking model asked for `format:"json"` returns an EMPTY string (its reasoning
 *     stream is suppressed and nothing else is emitted), so quick-add enrichment, plan
 *     ordering and every other `generateJson` caller silently get nothing. `qwen3.5:0.8b`
 *     reproduces this; `llama3.2` (no `thinking`) answers correctly.
 *   - remaining `completion` models are ranked by parameter count: the small/fast tier
 *     takes the smallest (latency dominates triage work), the medium/quality tier the
 *     largest (headroom matters for briefings).
 *
 * Capability metadata only exists on newer Ollama releases. When it is missing the
 * filters degrade OPEN (a model stays a candidate unless something positively rules it
 * out) rather than selecting nothing at all.
 *
 * The installed set is a cache, not a live query: `resolveModel` is synchronous and sits
 * on the hot path of every inference call, so it can never await `/api/tags`. The cache is
 * filled by `mcp/ollama.ts status()` (boot, the Settings/integrations poll, and the
 * "Re-check" button). Until then it stays `null` = "unknown" and resolution behaves
 * exactly as it did before this file changed — which is also what keeps the test suite
 * deterministic on machines that do or do not happen to have Ollama running.
 */
import { sqlite } from '../db/index.js';
import { currentOwnerId } from './context.js';
import { config } from './config.js';

interface ModelPrefs {
  fast_model: string | null;
  quality_model: string | null;
  embed_model: string | null;
}

function modelPrefs(owner: string): ModelPrefs | undefined {
  return sqlite
    .prepare(`SELECT fast_model, quality_model, embed_model FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as ModelPrefs | undefined;
}

/** One entry of Ollama's `/api/tags`, reduced to what selection needs. */
export interface InstalledModel {
  /** Canonical tag as Ollama reports it, e.g. `llama3.2:latest`. */
  name: string;
  /** `capabilities` from /api/tags; [] on older Ollama releases that omit it. */
  capabilities: string[];
  /** `details.parameter_size` normalized to billions, or null when unparseable. */
  paramB: number | null;
}

/** null = never probed (offline, pre-boot, or under test) — deliberately distinct from []. */
let installed: InstalledModel[] | null = null;

/** Replace the cached installed set. `null` resets to "unknown". Called by ollama.status(). */
export function setInstalledModels(models: InstalledModel[] | null): void {
  installed = models;
}

/** The cached installed set, or null when never probed. */
export function installedModels(): InstalledModel[] | null {
  return installed;
}

/** `"3.2B"` → 3.2, `"873.44M"` → 0.87344, unparseable → null. */
export function parseParamB(size: string | null | undefined): number | null {
  if (!size) return null;
  const m = /^\s*([\d.]+)\s*([BM])\s*$/i.exec(size);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2].toUpperCase() === 'M' ? n / 1000 : n;
}

/**
 * The installed entry matching `name`, or null. Tolerant of a missing tag, because
 * Settings values and env vars are hand-typed: `llama3.2` matches `llama3.2:latest`.
 * Returns null when the installed set is unknown — callers must read that as
 * "can't tell", never as "not installed".
 */
export function matchInstalled(name: string | null | undefined): InstalledModel | null {
  if (!name || !installed) return null;
  const want = name.trim().toLowerCase();
  if (!want) return null;
  return (
    installed.find((m) => m.name.toLowerCase() === want) ??
    installed.find((m) => m.name.toLowerCase().split(':')[0] === want) ??
    null
  );
}

/** Is `name` present on this device? False when the set is unknown. */
export function isInstalled(name: string | null | undefined): boolean {
  return matchInstalled(name) !== null;
}

const EMBED_NAME_HINT = /embed/i;

/** Models usable for `generate`/`generateJson` — see the `thinking` note in the header. */
function generationCandidates(): InstalledModel[] {
  return (installed ?? []).filter((m) => {
    const caps = m.capabilities;
    if (caps.includes('embedding') || EMBED_NAME_HINT.test(m.name)) return false;
    if (caps.includes('thinking')) return false; // returns "" under format:json
    // Older Ollama omits capabilities entirely — don't rule a model out for that.
    return caps.length === 0 || caps.includes('completion');
  });
}

/** Models usable for `embed`. */
function embeddingCandidates(): InstalledModel[] {
  return (installed ?? []).filter(
    (m) => m.capabilities.includes('embedding') || (m.capabilities.length === 0 && EMBED_NAME_HINT.test(m.name)),
  );
}

/** Sort by size; unknown sizes sort last in both directions (we can't judge them). */
function bySize(dir: 'asc' | 'desc') {
  return (a: InstalledModel, b: InstalledModel): number => {
    if (a.paramB === null && b.paramB === null) return a.name.localeCompare(b.name);
    if (a.paramB === null) return 1;
    if (b.paramB === null) return -1;
    return dir === 'asc' ? a.paramB - b.paramB : b.paramB - a.paramB;
  };
}

/** Best installed generation model for a tier, or null when nothing qualifies. */
export function autoSelectModel(tier: 'small' | 'medium'): string | null {
  const ranked = generationCandidates().sort(bySize(tier === 'small' ? 'asc' : 'desc'));
  return ranked[0]?.name ?? null;
}

/** Best installed embedding model, or null when nothing qualifies. */
export function autoSelectEmbedModel(): string | null {
  // Smallest embedder is the right default: embedding is a bulk, latency-sensitive op.
  return embeddingCandidates().sort(bySize('asc'))[0]?.name ?? null;
}

/** Shared tail of the resolution order: env pin → installed default → auto-pick. */
function resolveConfigured(configured: string, pinned: boolean, auto: () => string | null): string {
  if (pinned) return configured; // operator said so, verbatim
  if (installed === null) return configured; // unknown → behave exactly as before
  if (matchInstalled(configured)) return configured; // the default really is here
  return auto() ?? configured; // rescue; else keep the default so errors name it
}

/**
 * Steps 2–4 only: env pin → installed default → auto-selected, with NO per-owner override.
 *
 * For code that runs outside an owner context, where `currentOwnerId()` throws by design
 * (boot-time health logging is the live caller). Falling back to the raw configured name
 * there would report `qwen2.5:0.5b` as the effective model while requests correctly use
 * the auto-selected one — exactly the mismatch this file exists to remove.
 */
export function resolveModelDefault(tier: 'small' | 'medium'): string {
  return tier === 'medium'
    ? resolveConfigured(config.ollamaMediumModel, config.ollamaPinned.medium, () => autoSelectModel('medium'))
    : resolveConfigured(config.ollamaSmallModel, config.ollamaPinned.small, () => autoSelectModel('small'));
}

/** Embedding equivalent of resolveModelDefault. */
export function resolveEmbedModelDefault(): string {
  return resolveConfigured(config.ollamaEmbedModel, config.ollamaPinned.embed, autoSelectEmbedModel);
}

/** Model for a tier — see the resolution order in the file header. */
export function resolveModel(tier: 'small' | 'medium', owner: string = currentOwnerId()): string {
  const override = (tier === 'medium' ? modelPrefs(owner)?.quality_model : modelPrefs(owner)?.fast_model)?.trim();
  return override || resolveModelDefault(tier);
}

/** Embedding model — same order as resolveModel. */
export function resolveEmbedModel(owner: string = currentOwnerId()): string {
  return modelPrefs(owner)?.embed_model?.trim() || resolveEmbedModelDefault();
}
