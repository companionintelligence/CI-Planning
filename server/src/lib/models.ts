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
 *   - `thinking` capability → EXCLUDED from generation. A thinking model asked for
 *     `format:"json"` can return an EMPTY `response` with its reasoning diverted into the
 *     separate `thinking` field, so quick-add enrichment, plan ordering and every other
 *     `generateJson` caller silently get nothing. Re-measured against Ollama 0.30.10
 *     (2026-07-30), where 3 of 5 installed thinking models reproduce it:
 *
 *       qwen3:8b            completion,tools,thinking          response=54  OK
 *       gemma4:31b          completion,vision,tools,thinking   response=57  OK
 *       qwen3-vl:8b         completion,vision,tools,thinking   response=0   EMPTY
 *       qwen3.6:27b         completion,vision,tools,thinking   response=0   EMPTY
 *       nemotron-cascade-2  completion,tools,thinking          response=0   EMPTY
 *
 *     Two things that measurement settles. It is NOT predictable from the capability
 *     set — `qwen3:8b` and `qwen3-vl:8b` differ only by `vision` and behave oppositely —
 *     so no cheap metadata rule can replace the blunt exclusion. And passing
 *     `think:false` does NOT rescue it: `qwen3-vl:8b` still answers empty. The only
 *     reliable test is to actually run the model, which costs a full load (tens of
 *     seconds for a 30B) and so cannot happen on the `status()` path. The exclusion is
 *     therefore deliberately over-broad: it wrongly benches `qwen3:8b`/`gemma4:31b`,
 *     which is cheap, rather than risk selecting a model that silently returns nothing,
 *     which is the failure this whole file exists to prevent. An operator who wants a
 *     specific thinking model can still force it — a Settings override and an env pin
 *     both bypass every filter here.
 *   - `tools` capability → PREFERRED. Instruction/function-calling tuning is the best
 *     available proxy for "can follow a structured-output prompt". Without this the fast
 *     tier is just "smallest completion model", which on a real box handed the
 *     latency-sensitive tagging/quick-add tier to `moondream:latest` — a 1B VISION model
 *     that is a valid `completion` model and a poor triage one. Models with no capability
 *     metadata at all rank as preferred too (degrade open, see below); anything left
 *     (vision-only, no tools) is used only when nothing better is installed.
 *   - within a preference band, models are ranked by parameter count: the small/fast tier
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
import { store } from '../db/store.js';
import { currentOwnerId } from './context.js';
import { config } from './config.js';

interface ModelPrefs {
  fast_model: string | null;
  quality_model: string | null;
  embed_model: string | null;
}

async function modelPrefs(owner: string): Promise<ModelPrefs | undefined> {
  return await store()
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

/**
 * Is this model plausibly instruction-tuned for structured output? `tools` is the signal;
 * absent capability metadata (older Ollama) counts as yes so we degrade open rather than
 * demoting every model on an older build. See the `tools` note in the header.
 */
export function isPreferredForGeneration(m: InstalledModel): boolean {
  return m.capabilities.length === 0 || m.capabilities.includes('tools');
}

/**
 * Generation candidates split into the preferred band and the last-resort band, each
 * ranked for `tier`. Selection always drains the preferred band first, so a vision-only
 * model is reached only when nothing tool-capable is installed.
 */
function rankedGenerationBands(tier: 'small' | 'medium'): InstalledModel[] {
  const sort = bySize(tier === 'small' ? 'asc' : 'desc');
  const all = generationCandidates();
  const preferred = all.filter(isPreferredForGeneration).sort(sort);
  const fallback = all.filter((m) => !isPreferredForGeneration(m)).sort(sort);
  return [...preferred, ...fallback];
}

/** Best installed generation model for a tier, or null when nothing qualifies. */
export function autoSelectModel(tier: 'small' | 'medium'): string | null {
  return rankedGenerationBands(tier)[0]?.name ?? null;
}

/** Best installed embedding model, or null when nothing qualifies. */
export function autoSelectEmbedModel(): string | null {
  // Smallest embedder is the right default: embedding is a bulk, latency-sensitive op.
  return embeddingCandidates().sort(bySize('asc'))[0]?.name ?? null;
}

/**
 * Where an effective model name came from. Reported to Settings so an auto-selected
 * model is never mistaken for one the operator chose — the whole class of bug this file
 * addresses is a plausible-looking model name with nothing good behind it.
 */
export type ModelSource =
  /** This owner's explicit choice in Settings, used verbatim. */
  | 'override'
  /** An operator env pin (OLLAMA_*), used verbatim. */
  | 'pin'
  /** Installed set never probed (Ollama offline / pre-boot / tests) — configured name as-is. */
  | 'unknown'
  /** The built-in default, which really is installed. */
  | 'default'
  /** Auto-selected from what the device actually has. */
  | 'auto'
  /** Nothing installed qualified; the default is kept so the eventual error names it. */
  | 'unresolved';

export interface ResolvedModel {
  name: string;
  source: ModelSource;
}

/** Shared tail of the resolution order: env pin → installed default → auto-pick. */
function resolveConfiguredDetailed(configured: string, pinned: boolean, auto: () => string | null): ResolvedModel {
  if (pinned) return { name: configured, source: 'pin' }; // operator said so, verbatim
  if (installed === null) return { name: configured, source: 'unknown' }; // behave exactly as before
  if (matchInstalled(configured)) return { name: configured, source: 'default' }; // really is here
  const picked = auto();
  if (picked) return { name: picked, source: 'auto' }; // rescue
  return { name: configured, source: 'unresolved' }; // keep the default so errors name it
}

function resolveConfigured(configured: string, pinned: boolean, auto: () => string | null): string {
  return resolveConfiguredDetailed(configured, pinned, auto).name;
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
export async function resolveModel(tier: 'small' | 'medium', owner: string = currentOwnerId()): Promise<string> {
  const prefs = await modelPrefs(owner);
  const override = (tier === 'medium' ? prefs?.quality_model : prefs?.fast_model)?.trim();
  return override || resolveModelDefault(tier);
}

/** Embedding model — same order as resolveModel. */
export async function resolveEmbedModel(owner: string = currentOwnerId()): Promise<string> {
  return (await modelPrefs(owner))?.embed_model?.trim() || resolveEmbedModelDefault();
}

/** `resolveModel` plus the reason, without the per-owner override. */
export function explainModelDefault(tier: 'small' | 'medium'): ResolvedModel {
  return tier === 'medium'
    ? resolveConfiguredDetailed(config.ollamaMediumModel, config.ollamaPinned.medium, () => autoSelectModel('medium'))
    : resolveConfiguredDetailed(config.ollamaSmallModel, config.ollamaPinned.small, () => autoSelectModel('small'));
}

/** Embedding equivalent of explainModelDefault. */
export function explainEmbedModelDefault(): ResolvedModel {
  return resolveConfiguredDetailed(config.ollamaEmbedModel, config.ollamaPinned.embed, autoSelectEmbedModel);
}

/** As `explainModelDefault`, but a per-owner Settings override wins and reports as such. */
export async function explainModel(tier: 'small' | 'medium', owner: string = currentOwnerId()): Promise<ResolvedModel> {
  const prefs = await modelPrefs(owner);
  const override = (tier === 'medium' ? prefs?.quality_model : prefs?.fast_model)?.trim();
  return override ? { name: override, source: 'override' } : explainModelDefault(tier);
}

/** Embedding equivalent of explainModel. */
export async function explainEmbedModel(owner: string = currentOwnerId()): Promise<ResolvedModel> {
  const override = (await modelPrefs(owner))?.embed_model?.trim();
  return override ? { name: override, source: 'override' } : explainEmbedModelDefault();
}

/**
 * Cautions about the models actually in force — the "silently poor pick" surface.
 *
 * Only auto-selected tiers are reported: a pin or an explicit Settings choice is a
 * deliberate act and is never second-guessed (same rule as resolution itself). A tier
 * that fell through to the last-resort band means nothing tool-capable was installed,
 * which is exactly the state that quietly handed a 1B vision model the fast tier.
 */
export function generationSelectionWarnings(
  resolved: { tier: 'small' | 'medium'; model: ResolvedModel }[],
): string[] {
  const warnings: string[] = [];
  for (const { tier, model } of resolved) {
    if (model.source !== 'auto') continue;
    const entry = matchInstalled(model.name);
    if (entry && !isPreferredForGeneration(entry)) {
      const label = tier === 'small' ? 'Fast' : 'Quality';
      warnings.push(
        `${label} model auto-selected ${model.name}, which does not advertise tool use — ` +
          `it may handle structured-output prompts poorly. Pull an instruction-tuned model ` +
          `(e.g. \`ollama pull qwen2.5:7b\`) or pick one explicitly below.`,
      );
    }
  }
  return warnings;
}
