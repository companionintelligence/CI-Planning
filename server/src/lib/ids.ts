import { randomFillSync } from 'node:crypto';

/**
 * Fixed UUIDv7-shaped id for the single system owner (single-owner mode). Stable
 * so `currentOwnerId()` stays O(1); migration 0030 maps the legacy integer owner
 * `1` to this constant rather than a random uuid. (Phase I assigns real owners.)
 */
export const SYSTEM_OWNER_ID = '00000000-0000-7000-8000-000000000001';

/**
 * RFC 9562 **UUIDv7** — a 48-bit big-endian Unix-ms timestamp, version `7`, the
 * `10` variant, and 74 random bits. Time-ordered, so it preserves the index
 * locality that integer autoincrement gave us (unlike random v4), while being
 * globally unique and client-mintable.
 *
 * The canonical entity-id generator (CON-1). Used three ways, all producing the
 * same dashed format:
 *  - Drizzle inserts via `$defaultFn(newId)` (see schema.ts),
 *  - raw-SQL inserts via the `uuid7()` SQLite function registered in db/index.ts,
 *  - TS-side minting (recall=clone, future client) by calling `newId()` directly.
 */
export function newId(): string {
  const b = Buffer.alloc(16);
  randomFillSync(b);
  const ms = Date.now();
  // 48-bit timestamp, big-endian, across the first 6 bytes.
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
