-- migrate:up

-- `uuid7()` as a database function, because 386 raw-SQL call sites across the app say
-- `INSERT INTO … VALUES (uuid7(), …)`. The SQLite build registered it on the driver
-- handle (`sqlite.function('uuid7', …)` in db/index.ts), which has no Postgres
-- equivalent — a server-side function is what keeps those statements portable instead
-- of rewriting every one of them to pass an app-generated id.
--
-- Time-ordered ids are load-bearing here, not cosmetic: possible-task dedupe and the
-- flight-plan both rely on `ORDER BY id` being chronological (uuid7 is why "rows sort
-- id ASC, uuid7 is time-ordered" appears in the dedupe reasoning). A plain
-- gen_random_uuid() would silently break that ordering.
--
-- Layout per RFC 9562 §5.7: 48-bit big-endian unix ms, 4-bit version (0111), 12 bits
-- random, 2-bit variant (10), 62 bits random. The random tail is taken from
-- gen_random_uuid() so this needs no pgcrypto. (PG18 ships a native uuidv7(); when the
-- shared instance is on 18+ this can become a thin wrapper over it.)
CREATE OR REPLACE FUNCTION planning.uuid7() RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  ts_ms  bigint;
  buf    bytea;
BEGIN
  ts_ms := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;

  -- int8send gives 8 big-endian bytes; the low 6 are the 48-bit timestamp.
  buf := substring(int8send(ts_ms) FROM 3 FOR 6)
         || substring(uuid_send(gen_random_uuid()) FROM 7 FOR 10);

  -- Byte 6: high nibble = version 7. Byte 8: high two bits = variant 0b10.
  buf := set_byte(buf, 6, (get_byte(buf, 6) & 15) | 112);
  buf := set_byte(buf, 8, (get_byte(buf, 8) & 63) | 128);

  RETURN encode(buf, 'hex')::uuid;
END;
$$;

-- migrate:down
DROP FUNCTION IF EXISTS planning.uuid7();
