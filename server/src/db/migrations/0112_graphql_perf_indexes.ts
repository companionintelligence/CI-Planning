import type { Database } from 'better-sqlite3';

export const id = '0112_graphql_perf_indexes';

/**
 * Phase W close — the keyset-pagination perf indexes deferred from the TagType
 * merge (#238). The GraphQL tag-taxonomy connections page over a stable composite
 * key; these indexes make the hot ones seek-and-scan instead of scan-and-sort.
 *
 * 1. `idx_tags_owner_kind_name_id` on tags(owner_id, kind, name, id)
 *    Fully serves the `tags(kind:)` connection (`pageOwnerTagsByKind`): the
 *    `WHERE owner_id=? AND kind=?` prefix seeks, and because the index continues
 *    on (name, id) — the exact `ORDER BY t.name, t.id` — the sort is
 *    index-satisfied. EXPLAIN QUERY PLAN confirms NO `USE TEMP B-TREE FOR ORDER
 *    BY` for that query. The direction/category CHILD + PARENT page/count queries
 *    also drive from tags via this index for their owner_id+kind filter (the
 *    junction side is served by its composite PK).
 *
 * 2/3. `idx_tag_directions_dir_int` on tag_directions(direction_tag_id, intention_tag_id)
 *      `idx_tag_categories_cat_int`  on tag_categories(category_tag_id, intention_tag_id)
 *    Cover the reverse-lookup / membership-probe direction (`WHERE
 *    <parent>_tag_id=?`) that the composite PRIMARY KEY — led by
 *    intention_tag_id — cannot serve: the `catRefByMember` / count / delete-guard
 *    probes and any parent→children seek. Covering: both columns come straight
 *    from the index, no table row fetch.
 *
 * The composite PKs already serve the parent lookups (`pageParentDirections` /
 * `pageParentCategories`, `WHERE intention_tag_id=?`) and the child-join key, so
 * no index is added there.
 *
 * These two new composites are exact SUPERSETS of the pre-existing single-column
 * indexes `idx_tag_directions_direction` (0105, on tag_directions(direction_tag_id))
 * and `ix_tag_categories_cat` (0069, on tag_categories(category_tag_id)) — a
 * `(parent)` prefix is fully superseded by `(parent, child)` for every query,
 * including the `WHERE <parent>=? LIMIT 1` probes. EXPLAIN QUERY PLAN confirms
 * that with the singles dropped, those probes fall cleanly to the composite as a
 * COVERING index (no regression), so we drop the redundant singles for hygiene.
 *
 * Purely a performance/hygiene change: no data change, no behavior change, no
 * schema.ts change (indexes aren't modeled in drizzle here). Additive +
 * idempotent (CREATE/DROP INDEX IF [NOT] EXISTS), replay-safe under the
 * 0001→0112 boot replay.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tags_owner_kind_name_id ON tags(owner_id, kind, name, id);
    CREATE INDEX IF NOT EXISTS idx_tag_directions_dir_int  ON tag_directions(direction_tag_id, intention_tag_id);
    CREATE INDEX IF NOT EXISTS idx_tag_categories_cat_int  ON tag_categories(category_tag_id, intention_tag_id);

    -- The two new composites fully supersede these single-column prefixes.
    DROP INDEX IF EXISTS idx_tag_directions_direction; -- 0105, tag_directions(direction_tag_id)
    DROP INDEX IF EXISTS ix_tag_categories_cat;        -- 0069, tag_categories(category_tag_id)
  `);
}
