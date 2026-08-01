import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Per-(owner × connection) display config — the colour and stripe texture the calendar
 * paints events mirrored from that source with. A sibling of services/category-prefs.ts
 * with the same fetch-merge-upsert shape; the difference is the key, which is the
 * (provider, account) pair rather than a row id (see migration 0145 for why).
 */

/** The stripe geometries a connection can be given. Names, not CSS — the rendering
 *  (angle, line width, alpha) is the client's business and retunes without a migration. */
export const CONNECTION_TEXTURES = ['none', 'diagonal', 'reverse', 'vertical', 'horizontal', 'grid'] as const;
export type ConnectionTexture = (typeof CONNECTION_TEXTURES)[number];

export interface ConnectionPref {
  color_token: string;
  texture: ConnectionTexture;
}

const DEFAULT_PREF: ConnectionPref = { color_token: 'primary', texture: 'none' };

/** Key for the returned map. Mirrors how the client joins a block to its source. */
export function connectionKey(provider: string, account: string): string {
  return `${provider}:${account}`;
}

type PrefCols = { color_token: string; texture: string };

function rowToPref(r: PrefCols): ConnectionPref {
  const texture = CONNECTION_TEXTURES.includes(r.texture as ConnectionTexture)
    ? (r.texture as ConnectionTexture)
    : 'none';
  return { color_token: r.color_token || 'primary', texture };
}

/**
 * Every connection pref the owner holds, keyed `provider:account`. Rows for
 * disconnected accounts are included by design — reconnecting restores the look —
 * so callers key off the connection list, not this map, when rendering a picker.
 */
export function getConnectionPrefs(ownerId: string): Record<string, ConnectionPref> {
  const rows = sqlite
    .prepare(`SELECT provider, account, color_token, texture FROM connection_prefs WHERE owner_id = ?`)
    .all(ownerId) as (PrefCols & { provider: string; account: string })[];
  const out: Record<string, ConnectionPref> = {};
  for (const r of rows) out[connectionKey(r.provider, r.account)] = rowToPref(r);
  return out;
}

/** Upsert one connection pref, merging `patch` over the existing (or default) row. */
export function setConnectionPref(
  ownerId: string,
  provider: string,
  account: string,
  patch: Partial<ConnectionPref>,
): ConnectionPref {
  const existing = sqlite
    .prepare(`SELECT color_token, texture FROM connection_prefs WHERE owner_id = ? AND provider = ? AND account = ?`)
    .get(ownerId, provider, account) as PrefCols | undefined;

  const current = existing ? rowToPref(existing) : { ...DEFAULT_PREF };
  const merged: ConnectionPref = {
    color_token: patch.color_token !== undefined ? patch.color_token : current.color_token,
    texture: patch.texture !== undefined ? patch.texture : current.texture,
  };

  sqlite
    .prepare(
      `INSERT INTO connection_prefs (id, owner_id, provider, account, color_token, texture)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, provider, account)
       DO UPDATE SET color_token = excluded.color_token, texture = excluded.texture`,
    )
    .run(newId(), ownerId, provider, account, merged.color_token, merged.texture);

  return merged;
}

export type SetConnectionPrefResult =
  | { ok: true; pref: ConnectionPref }
  | { ok: false; error: 'connection_not_found' | 'color_token_invalid' | 'texture_invalid' };

/**
 * Validate + upsert. The connection must exist for THIS owner — that check is what
 * keeps the table from becoming an unbounded owner-writable key/value store, and it
 * scopes writes so one owner can never author a pref keyed to another's account.
 */
export function setConnectionPrefChecked(
  ownerId: string,
  provider: string,
  account: string,
  patch: { color_token?: unknown; texture?: unknown },
): SetConnectionPrefResult {
  const known = sqlite
    .prepare(`SELECT 1 AS ok FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?`)
    .get(ownerId, provider, account) as { ok: number } | undefined;
  if (!known) return { ok: false, error: 'connection_not_found' };

  if (patch.color_token !== undefined && (typeof patch.color_token !== 'string' || !patch.color_token)) {
    return { ok: false, error: 'color_token_invalid' };
  }
  if (patch.texture !== undefined && !CONNECTION_TEXTURES.includes(patch.texture as ConnectionTexture)) {
    return { ok: false, error: 'texture_invalid' };
  }

  const pref = setConnectionPref(ownerId, provider, account, {
    color_token: patch.color_token as string | undefined,
    texture: patch.texture as ConnectionTexture | undefined,
  });
  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `connection-prefs:${provider}:${account}` });
  return { ok: true, pref };
}
