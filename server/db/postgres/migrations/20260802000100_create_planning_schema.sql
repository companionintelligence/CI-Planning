-- migrate:up

-- CI-Planning's tables live in their OWN schema alongside CI-Server's `ci.*` in the
-- same database. Two schemas rather than one keeps `owners` the tenant table it is
-- today (linked to CI-Portal by external_subject) instead of re-keying every
-- tenant-scoped table onto ci.users — but sharing the DATABASE means a later
-- cross-schema read or FK into `ci.*` is available without another migration.
--
-- Each repo owns its own migration history; nothing here touches `ci`.
CREATE SCHEMA IF NOT EXISTS planning;

-- migrate:down
DROP SCHEMA IF EXISTS planning CASCADE;
