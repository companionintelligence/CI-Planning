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
 * Serialize a task row to API shape, deriving the `is_habit` / `is_fast_task`
 * booleans from the canonical `subtype` (CON-2c / W1-A). The columns were dropped
 * in migration 0048; these fields are synthesised here so existing clients that
 * read them in the payload continue to work without any client-side change.
 */
export function taskToApi<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const api = toApi(row);
  const subtype = (row as { subtype?: string }).subtype ?? 'standard';
  api.is_habit = subtype === 'habit';
  api.is_fast_task = subtype === 'quick';
  return api;
}
