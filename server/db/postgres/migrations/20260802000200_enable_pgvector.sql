-- migrate:up

-- Replaces the `sqlite-vec` extension the SQLite build loaded at boot. Used ONLY by
-- possible-task dedupe (agents/groom.ts), which builds a transient KNN index per run
-- — there is no persisted embedding column, so nothing in the baseline schema carries
-- a `vector` type. Created here so the dedupe path can create its temp table.
--
-- Mirrors CI-Server's own 20250528215624_enable_pgvector.sql; the extension is
-- database-wide, so if CI-Server already enabled it this is a no-op.
CREATE EXTENSION IF NOT EXISTS vector;

-- migrate:down
-- Deliberately NOT dropped: the extension is shared with CI-Server's `ci` schema and
-- dropping it here would break embeddings that have nothing to do with planning.
