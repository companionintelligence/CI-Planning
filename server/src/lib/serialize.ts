/** Convert a camelCase key to snake_case. */
function toSnakeKey(k: string): string {
  return k.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/** Convert a snake_case key to camelCase. */
function toCamelKey(k: string): string {
  return k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Serialize a Drizzle row (camelCase keys) to an API response object (snake_case keys). */
export function toApi<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[toSnakeKey(k)] = v;
  }
  return out;
}

/** Deserialize an incoming API payload (snake_case) to a Drizzle-compatible object (camelCase). */
export function fromApi<T = Record<string, unknown>>(obj: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[toCamelKey(k)] = v;
  }
  return out as T;
}

/** Map an array of Drizzle rows to API snake_case objects. */
export function toApiList<T extends Record<string, unknown>>(rows: T[]): Record<string, unknown>[] {
  return rows.map(toApi);
}

/**
 * Serialize a task row to API shape, deriving the legacy `is_habit` / `is_fast_task`
 * booleans from the canonical `subtype` (CON-2c / W1-A §5a). Routing every task
 * serialization through here makes `subtype` the single source of the API's habit/
 * quick flags, so the `is_habit` / `is_fast_task` columns can be dropped (W1-A PR2)
 * without changing any payload. While the columns still exist they are coherent with
 * `subtype`, so this returns byte-identical output to a plain `toApi`.
 */
export function taskToApi<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const api = toApi(row);
  const subtype = (row as { subtype?: string }).subtype ?? 'standard';
  api.is_habit = subtype === 'habit';
  api.is_fast_task = subtype === 'quick';
  return api;
}
