import { store } from '../db/store.js';

/**
 * Phase Z · Z0 (Time-Sense) — scoped estimate calibration.
 *
 * Shared by the nightly calibrate_estimates job (writer), the calibration REST
 * surface, and (later, Z6) suggestEstimate. Everything here is deterministic;
 * nothing ever writes tasks.estimated_minutes or tag defaults — calibration is
 * suggest-only (design constraint 4, test-enforced).
 */

export type ScopeKind = 'global' | 'subtype' | 'tag' | 'tag_combo' | 'category' | 'objective';

export interface ScopeStats {
  scope_kind: ScopeKind;
  scope_ref: string;
  sample_count: number;
  bias_ratio: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

/** Ratios are capped into this band before any stats — a 100× ratio is a data bug, not a bias. */
const RATIO_CAP: [number, number] = [0.1, 10];
/** Outliers beyond median ± OUTLIER_MADS·MAD are dropped (robust to the odd derailed day). */
const OUTLIER_MADS = 3;
/** Below this sample count a scope is silent — the resolver falls to a broader scope. */
export const CONFIDENCE_FLOOR = 5;
/** ≥ this count the scope is 'confident'; between floor and this it's 'tentative'. */
export const CONFIDENCE_STRONG = 12;
/** A pinnable combo must diverge from every ≥floor component tag by at least this fraction. */
const COMBO_DIVERGENCE = 0.25;

/** Sorted '+'-joined tag-id tuple — the canonical tag_combo scope_ref. */
export function comboRef(tagIds: string[]): string {
  return [...tagIds].sort().join('+');
}

/** The same index-quantile Phase N used (0083) — kept so global stats stay comparable. */
function quantile(sorted: number[], frac: number): number {
  const n = sorted.length;
  const idx = Math.min(Math.max(0, Math.round(frac * (n - 1))), n - 1);
  return sorted[idx];
}

/**
 * Robust per-scope stats: cap ratios into RATIO_CAP, drop outliers outside
 * median ± 3·MAD (MAD = 0 → no spread signal → keep all), then quartiles of the
 * retained set. sample_count is the RETAINED count — the confidence tiers read it.
 */
export function robustStats(ratios: number[]): Omit<ScopeStats, 'scope_kind' | 'scope_ref'> {
  if (ratios.length === 0) return { sample_count: 0, bias_ratio: null, p25: null, p50: null, p75: null };
  const capped = ratios.map((r) => Math.min(RATIO_CAP[1], Math.max(RATIO_CAP[0], r))).sort((a, b) => a - b);
  const median = quantile(capped, 0.5);
  const absDev = capped.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const mad = quantile(absDev, 0.5);
  const kept = mad === 0 ? capped : capped.filter((r) => Math.abs(r - median) <= OUTLIER_MADS * mad);
  return {
    sample_count: kept.length,
    bias_ratio: quantile(kept, 0.5),
    p25: quantile(kept, 0.25),
    p50: quantile(kept, 0.5),
    p75: quantile(kept, 0.75),
  };
}

interface TaskSample {
  id: string;
  subtype: string;
  ratio: number;
  tagIds: string[];
  categoryIds: string[];
  objectiveIds: string[];
}

/**
 * Every calibration-eligible task for the owner (done, both minute fields > 0)
 * with its scope memberships. actual_minutes only ever comes from summed
 * time_entries (services/timer.ts), so a nonzero value is a measured actual —
 * timer-less completions stay at 0 and are excluded here (N L169: imputed
 * values never enter calibration).
 */
async function gatherSamples(ownerId: string): Promise<TaskSample[]> {
  const tasks = await store()
    .prepare(
      `SELECT id, COALESCE(subtype, 'standard') AS subtype,
              CAST(actual_minutes AS REAL) / estimated_minutes AS ratio
         FROM tasks
        WHERE owner_id = ? AND status = 'done'
          AND estimated_minutes > 0 AND actual_minutes > 0`,
    )
    .all<{ id: string; subtype: string; ratio: number }>(ownerId);
  if (tasks.length === 0) return [];

  const byTask = new Map<string, TaskSample>();
  for (const t of tasks) byTask.set(t.id, { ...t, tagIds: [], categoryIds: [], objectiveIds: [] });

  const tagRows = await store()
    .prepare(
      `SELECT et.entity_id AS task_id, et.tag_id
         FROM entity_tags et
         JOIN tasks t ON t.id = et.entity_id
        WHERE t.owner_id = ? AND et.entity_kind = 'task' AND et.level = 1
          AND t.status = 'done' AND t.estimated_minutes > 0 AND t.actual_minutes > 0`,
    )
    .all<{ task_id: string; tag_id: string }>(ownerId);
  for (const r of tagRows) byTask.get(r.task_id)?.tagIds.push(r.tag_id);

  const catRows = await store()
    .prepare(
      `SELECT DISTINCT et.entity_id AS task_id, tc.category_tag_id
         FROM entity_tags et
         JOIN tag_categories tc ON tc.intention_tag_id = et.tag_id
         JOIN tasks t ON t.id = et.entity_id
        WHERE t.owner_id = ? AND et.entity_kind = 'task' AND et.level = 1
          AND t.status = 'done' AND t.estimated_minutes > 0 AND t.actual_minutes > 0`,
    )
    .all<{ task_id: string; category_tag_id: string }>(ownerId);
  for (const r of catRows) byTask.get(r.task_id)?.categoryIds.push(r.category_tag_id);

  const objRows = await store()
    .prepare(
      `SELECT ot.task_id, ot.objective_id
         FROM objective_tasks ot
         JOIN tasks t ON t.id = ot.task_id
        WHERE t.owner_id = ? AND t.status = 'done' AND t.estimated_minutes > 0 AND t.actual_minutes > 0`,
    )
    .all<{ task_id: string; objective_id: string }>(ownerId);
  for (const r of objRows) byTask.get(r.task_id)?.objectiveIds.push(r.objective_id);

  return [...byTask.values()];
}

/**
 * Full per-scope recompute for one owner. Groups the eligible tasks into every
 * scope they belong to — global always; subtype/tag/category/objective by
 * membership; tag_combo ONLY for user-pinned refs (calibration_combo_pins) —
 * and returns robust stats per scope. The caller persists.
 */
export async function computeScopedCalibration(ownerId: string): Promise<ScopeStats[]> {
  const samples = await gatherSamples(ownerId);
  const pinned = new Set(
    (await store()
      .prepare(`SELECT scope_ref FROM calibration_combo_pins WHERE owner_id = ?`)
      .all<{ scope_ref: string }>(ownerId)).map((r) => r.scope_ref),
  );

  const groups = new Map<string, { scope_kind: ScopeKind; scope_ref: string; ratios: number[] }>();
  const add = (scope_kind: ScopeKind, scope_ref: string, ratio: number) => {
    // U+0000 as the delimiter: it cannot occur in a scope_kind or a tag id, so the
    // composite key is unambiguous. Written as an ESCAPE, not a raw NUL byte — a raw
    // one makes this file `data` rather than text, and every grep in the repo then
    // skips it silently (GNU grep suppresses binary line output; ugrep drops the file
    // entirely, even for -l). That is how this file came to be catalogued as holding
    // no raw sqlite statements when it in fact holds fourteen.
    const key = `${scope_kind}\u0000${scope_ref}`;
    let g = groups.get(key);
    if (!g) {
      g = { scope_kind, scope_ref, ratios: [] };
      groups.set(key, g);
    }
    g.ratios.push(ratio);
  };

  for (const s of samples) {
    add('global', '', s.ratio);
    add('subtype', s.subtype, s.ratio);
    for (const tagId of s.tagIds) add('tag', tagId, s.ratio);
    for (const catId of s.categoryIds) add('category', catId, s.ratio);
    for (const objId of s.objectiveIds) add('objective', objId, s.ratio);
    if (s.tagIds.length >= 2) {
      const ref = comboRef(s.tagIds);
      if (pinned.has(ref)) add('tag_combo', ref, s.ratio);
    }
  }
  // An owner with no samples still gets an empty global row — "computed, nothing
  // to say" is distinct from "never computed".
  if (samples.length === 0) return [{ scope_kind: 'global', scope_ref: '', ...robustStats([]) }];

  return [...groups.values()].map((g) => ({ scope_kind: g.scope_kind, scope_ref: g.scope_ref, ...robustStats(g.ratios) }));
}

/**
 * Human label for a scope ref (never a raw id): tag/category → tag name,
 * tag_combo → 'a + b', objective → title, subtype → the subtype word, global →
 * 'overall'. Unknown ids (deleted tags) fall back to the ref. Shared by the EOD
 * Alignment and the estimate chip so both speak the same way.
 */
export async function scopeLabel(ownerId: string, kind: ScopeKind, ref: string): Promise<string> {
  const tagName = async (id: string) =>
    (await store().prepare(`SELECT name FROM tags WHERE id = ? AND owner_id = ?`).get<{ name: string }>(id, ownerId))?.name ?? id;
  if (kind === 'global') return 'overall';
  if (kind === 'subtype') return ref;
  if (kind === 'tag' || kind === 'category') return await tagName(ref);
  if (kind === 'tag_combo') {
    // An explicit loop, NOT `.map(tagName).join(' + ')`. With tagName async that join
    // stringifies PROMISES, so the combo label becomes
    // "[object Promise] + [object Promise]" — straight into the estimate chip and the
    // EOD Alignment copy. String coercion never throws, tsc infers `string` from the
    // template context, and no test asserts the exact combo label, so nothing would
    // have caught it.
    const names: string[] = [];
    for (const id of ref.split('+')) names.push(await tagName(id));
    return names.join(' + ');
  }
  if (kind === 'objective') {
    return (await store().prepare(`SELECT title FROM objectives WHERE id = ? AND owner_id = ?`).get<{ title: string }>(ref, ownerId))?.title ?? ref;
  }
  return ref;
}

export interface ResolvedCalibration extends ScopeStats {
  confidence: 'tentative' | 'confident';
}

/**
 * Scope-fallback ladder (§2.3): tag_combo → single tag → category → subtype →
 * objective → global. First scope at/above the confidence floor wins; among
 * same-kind candidates the largest sample wins (ties: lexicographic ref, so the
 * pick is deterministic). Null when even global is below floor — the caller
 * shows nothing (silence beats noise).
 */
export async function resolveCalibration(ownerId: string, taskId: string): Promise<ResolvedCalibration | null> {
  const task = await store()
    .prepare(`SELECT COALESCE(subtype,'standard') AS subtype FROM tasks WHERE id = ? AND owner_id = ?`)
    .get<{ subtype: string }>(taskId, ownerId);
  if (!task) return null;

  const tagIds = (await store()
    .prepare(`SELECT tag_id FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ? AND level = 1`)
    .all<{ tag_id: string }>(taskId)).map((r) => r.tag_id);
  const categoryIds = (await store()
    .prepare(
      `SELECT DISTINCT tc.category_tag_id FROM entity_tags et
         JOIN tag_categories tc ON tc.intention_tag_id = et.tag_id
        WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1`,
    )
    .all<{ category_tag_id: string }>(taskId)).map((r) => r.category_tag_id);
  const objectiveIds = (await store()
    .prepare(`SELECT objective_id FROM objective_tasks WHERE task_id = ?`)
    .all<{ objective_id: string }>(taskId)).map((r) => r.objective_id);

  const ladder: { scope_kind: ScopeKind; refs: string[] }[] = [
    { scope_kind: 'tag_combo', refs: tagIds.length >= 2 ? [comboRef(tagIds)] : [] },
    { scope_kind: 'tag', refs: tagIds },
    { scope_kind: 'category', refs: categoryIds },
    { scope_kind: 'subtype', refs: [task.subtype] },
    { scope_kind: 'objective', refs: objectiveIds },
    { scope_kind: 'global', refs: [''] },
  ];

  const read = store().prepare(
    `SELECT scope_kind, scope_ref, sample_count, bias_ratio, p25, p50, p75
       FROM estimate_calibration WHERE owner_id = ? AND scope_kind = ? AND scope_ref = ?`,
  );
  for (const rung of ladder) {
    // An explicit loop, NOT `.map(read.get).filter(…)`. With an async `read.get` the
    // map yields promises; each is truthy so `!!r` passes, but `r.sample_count` is
    // undefined and `undefined >= CONFIDENCE_FLOOR` is false — so the filter would
    // drop EVERY candidate on every rung and resolveCalibration would return null for
    // every task, silently turning the whole feature off. The `r is ScopeStats`
    // predicate would have asserted the lie right past the type checker.
    const candidates: ScopeStats[] = [];
    for (const ref of rung.refs) {
      const row = await read.get<ScopeStats>(ownerId, rung.scope_kind, ref);
      if (row && row.sample_count >= CONFIDENCE_FLOOR) candidates.push(row);
    }
    candidates.sort((a, b) => b.sample_count - a.sample_count || a.scope_ref.localeCompare(b.scope_ref));
    if (candidates.length) {
      const best = candidates[0];
      return { ...best, confidence: best.sample_count >= CONFIDENCE_STRONG ? 'confident' : 'tentative' };
    }
  }
  return null;
}

export interface EstimateSuggestion {
  task_id: string;
  current_minutes: number;
  suggested_minutes: number;
  delta_minutes: number;
  bias_ratio: number;
  scope_kind: ScopeKind;
  scope_ref: string;
  scope_label: string;
  confidence: 'tentative' | 'confident';
}

/** Don't nag below a 5-minute change… */
const SUGGEST_MIN_DELTA = 5;
/** …or below a 15% bias — noise, not signal. */
const SUGGEST_MIN_DIVERGENCE = 0.15;

/**
 * Phase Z · Z6 — the suggest-only estimate nudge (NEW — Phase N never shipped
 * this despite the spec naming it). Given a task with a current estimate,
 * resolves its scoped bias and proposes a bumped default, snapped to 5-minute
 * steps. Returns null when there's nothing worth saying: no current estimate,
 * no scope above the confidence floor, a near-1.0 bias, or a sub-5-minute delta.
 *
 * PURE READ — it never writes. "Accept" is the client setting the estimate field
 * and the user saving (an explicit human write via PATCH /api/tasks), per the
 * design's suggest-only constraint.
 */
export async function suggestEstimate(ownerId: string, taskId: string): Promise<EstimateSuggestion | null> {
  const task = await store()
    .prepare(`SELECT estimated_minutes FROM tasks WHERE id = ? AND owner_id = ?`)
    .get<{ estimated_minutes: number | null }>(taskId, ownerId);
  if (!task || !task.estimated_minutes || task.estimated_minutes <= 0) return null;

  const cal = await resolveCalibration(ownerId, taskId);
  if (!cal || cal.bias_ratio == null) return null;
  // The 15% cutoff is inclusive: a true 15% bias (e.g. ratio exactly 1.15, which
  // in IEEE-754 is 0.14999…) should still suggest, so subtract a tiny epsilon.
  if (Math.abs(cal.bias_ratio - 1) < SUGGEST_MIN_DIVERGENCE - 1e-9) return null;

  const suggested = Math.max(5, Math.round((task.estimated_minutes * cal.bias_ratio) / 5) * 5);
  const delta = suggested - task.estimated_minutes;
  if (Math.abs(delta) < SUGGEST_MIN_DELTA) return null;

  return {
    task_id: taskId,
    current_minutes: task.estimated_minutes,
    suggested_minutes: suggested,
    delta_minutes: delta,
    bias_ratio: cal.bias_ratio,
    scope_kind: cal.scope_kind,
    scope_ref: cal.scope_ref,
    // Awaited inside the object literal — an unawaited call here would serialize a
    // promise into the response body as `{}`.
    scope_label: await scopeLabel(ownerId, cal.scope_kind, cal.scope_ref),
    confidence: cal.confidence,
  };
}

export interface ComboSuggestion {
  scope_ref: string;
  tag_ids: string[];
  sample_count: number;
  combo_bias: number;
  /** The component-tag bias the combo diverges from most (for the suggestion copy). */
  component_bias: number;
}

/**
 * Detect UNPINNED tag combos worth suggesting (§2.3 hybrid): a tuple at/above
 * the confidence floor whose robust bias diverges ≥25% from EVERY component
 * single-tag scope that itself clears the floor (at least one such component
 * required — a combo of two silent tags has nothing to diverge from). Computed
 * on demand (regenerable), persisted only when the user confirms the pin.
 */
export async function detectComboSuggestions(ownerId: string): Promise<ComboSuggestion[]> {
  const samples = await gatherSamples(ownerId);
  const pinned = new Set(
    (await store()
      .prepare(`SELECT scope_ref FROM calibration_combo_pins WHERE owner_id = ?`)
      .all<{ scope_ref: string }>(ownerId)).map((r) => r.scope_ref),
  );

  const byTag = new Map<string, number[]>();
  const byCombo = new Map<string, { tag_ids: string[]; ratios: number[] }>();
  for (const s of samples) {
    for (const tagId of s.tagIds) {
      if (!byTag.has(tagId)) byTag.set(tagId, []);
      byTag.get(tagId)!.push(s.ratio);
    }
    if (s.tagIds.length >= 2) {
      const ref = comboRef(s.tagIds);
      if (pinned.has(ref)) continue;
      if (!byCombo.has(ref)) byCombo.set(ref, { tag_ids: [...s.tagIds].sort(), ratios: [] });
      byCombo.get(ref)!.ratios.push(s.ratio);
    }
  }

  const out: ComboSuggestion[] = [];
  for (const [ref, combo] of byCombo) {
    const stats = robustStats(combo.ratios);
    if (stats.sample_count < CONFIDENCE_FLOOR || stats.bias_ratio == null) continue;
    const componentBiases = combo.tag_ids
      .map((tagId) => robustStats(byTag.get(tagId) ?? []))
      .filter((s) => s.sample_count >= CONFIDENCE_FLOOR && s.bias_ratio != null);
    if (!componentBiases.length) continue;
    const divergesFromAll = componentBiases.every(
      (c) => Math.abs(stats.bias_ratio! / c.bias_ratio! - 1) >= COMBO_DIVERGENCE,
    );
    if (!divergesFromAll) continue;
    const most = componentBiases.reduce((a, b) =>
      Math.abs(stats.bias_ratio! / a.bias_ratio! - 1) >= Math.abs(stats.bias_ratio! / b.bias_ratio! - 1) ? a : b,
    );
    out.push({
      scope_ref: ref,
      tag_ids: combo.tag_ids,
      sample_count: stats.sample_count,
      combo_bias: stats.bias_ratio,
      component_bias: most.bias_ratio!,
    });
  }
  return out.sort((a, b) => b.sample_count - a.sample_count || a.scope_ref.localeCompare(b.scope_ref));
}
