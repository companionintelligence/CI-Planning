/**
 * Deterministic normalization for behavior-baseline snapshots (consolidation pass).
 *
 * The consolidation pass must prove it does NOT change behavior. Golden snapshots
 * only work if volatile / environment-dependent values are stabilized:
 *
 *  - **Entity ids** are autoincrement integers today and become **UUIDv7** in
 *    CON-1. Every id-bearing field is replaced by a **namespaced positional
 *    token** (`task#1`, `owner#1`, `block#2`, …) where the namespace is the
 *    *referent entity type* and the number is first-seen order within the
 *    snapshot. Namespacing matters: with integer ids, `owner_id=1` and a task
 *    `id=1` are equal, so a value-keyed tokenizer would conflate them — and they
 *    would *stop* conflating under UUIDs, changing the snapshot at CON-1 and
 *    defeating the purpose. Referent-namespaced tokens are identical whether ids
 *    are integers or uuids, and independent of autoincrement magnitude (so they
 *    survive suite ordering). References to the same entity share a token, so
 *    relationships (`parent_id` → that task's `id`) stay visible.
 *  - **Record-metadata timestamps** (`created_at`, …) → `<ts>`. **Domain
 *    instants** (`start_at`, `due_at`, `occurrence_date`, …) are KEPT — behavior.
 *  - **`source_ref`** → `<ref>` (it multiplexes external ids + the pattern marker).
 *  - Record arrays sorted by a natural key for order-independence; pass
 *    `{ sortArrays: false }` when order IS the behavior (the Auto sequence).
 *
 * Contract: snapshot `makeNormalizer()(body)`. An *unexplained* diff in a CON PR
 * is a regression; an *intended* output change updates the golden in the same PR.
 */

export interface NormalizeOpts {
  /** Sort record/scalar arrays for order-independence. Default true. */
  sortArrays?: boolean;
}

/** Array property name → referent entity type for the elements' `id`. */
const ARRAY_KEY_TYPE: Record<string, string> = {
  tasks: 'task', subtasks: 'task', blocks: 'block', patterns: 'pattern',
  pattern_types: 'patternType', tags: 'tag', block_templates: 'template',
  possible_tasks: 'possible', flight_plan: 'task',
};

/** FK field name → referent entity type (namespace). */
const FK_NS: Record<string, string> = {
  owner_id: 'owner', proposed_owner_id: 'owner',
  task_id: 'task', parent_id: 'task', depends_on_id: 'task',
  recurrence_parent_id: 'task', promoted_task_id: 'task',
  parent_block_id: 'block', block_id: 'block',
  tag_id: 'tag', type_id: 'patternType',
  pattern_id: 'pattern', source_pattern_id: 'pattern', job_id: 'job',
};

/** Array-of-id field name → referent entity type for each element. */
const ID_ARRAY_NS: Record<string, string> = { task_ids: 'task', depends_on: 'task' };

/** Record-metadata timestamps → blanked. Domain instants are deliberately absent. */
const TS_KEYS = new Set([
  'created_at', 'createdAt', 'completed_at', 'completedAt', 'added_at', 'addedAt',
  'updated_at', 'updatedAt', 'last_run_at', 'lastRunAt', 'next_run_at', 'nextRunAt',
  'finished_at', 'finishedAt', 'started_at', 'startedAt', 'last_used_at',
  'last_synced_at', 'memory_last_synced_at',
]);

const naturalKey = (o: any): string =>
  String(o?.title ?? o?.name ?? o?.raw_title ?? o?.day ?? o?.label ?? JSON.stringify(o));

/**
 * Build a normalizer with fresh token maps. Call once per snapshot so each golden
 * starts numbering at 1 per namespace and is self-contained.
 */
export function makeNormalizer(opts: NormalizeOpts = {}) {
  const sortArrays = opts.sortArrays ?? true;
  const counters = new Map<string, number>();
  const idMap = new Map<string, string>(); // `${ns}:${rawValue}` -> token

  const tok = (ns: string, raw: unknown): unknown => {
    if (raw === null || raw === undefined) return raw;
    const k = `${ns}:${String(raw)}`;
    let t = idMap.get(k);
    if (!t) {
      const n = (counters.get(ns) ?? 0) + 1;
      counters.set(ns, n);
      t = `${ns}#${n}`;
      idMap.set(k, t);
    }
    return t;
  };

  const walk = (val: any, key: string | undefined, type: string | undefined): any => {
    if (Array.isArray(val)) {
      if (key && ID_ARRAY_NS[key]) return val.map((x) => tok(ID_ARRAY_NS[key], x));
      const childType = (key && ARRAY_KEY_TYPE[key]) ?? type;
      const arr = val.slice();
      const hasObjects = arr.some((x) => x && typeof x === 'object');
      // Sort BEFORE walking so token numbering is deterministic and independent of
      // DB row order / id format.
      if (sortArrays && hasObjects) {
        arr.sort((a, b) => (naturalKey(a) < naturalKey(b) ? -1 : naturalKey(a) > naturalKey(b) ? 1 : 0));
      }
      const mapped = arr.map((x) => walk(x, undefined, childType));
      if (sortArrays && !hasObjects) mapped.sort();
      return mapped;
    }
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(val)) {
        const v = (val as Record<string, unknown>)[k];
        if (TS_KEYS.has(k)) out[k] = v == null ? null : '<ts>';
        else if (k === 'id') out[k] = tok(type ?? 'entity', v);
        else if (FK_NS[k]) out[k] = tok(FK_NS[k], v);
        else if (ID_ARRAY_NS[k]) out[k] = Array.isArray(v) ? v.map((x) => tok(ID_ARRAY_NS[k], x)) : v;
        else if (k === 'source_ref') out[k] = v == null ? null : '<ref>';
        else out[k] = walk(v, k, type);
      }
      return out;
    }
    return val;
  };

  return (v: unknown): unknown => walk(v, undefined, undefined);
}
