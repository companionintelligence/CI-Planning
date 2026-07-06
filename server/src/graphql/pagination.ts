import type { TagRow } from '../services/tags.js';

/**
 * Relay cursor helpers for the tag connections (Phase W). Forward-only pagination:
 * the cursor is the opaque base64url of the stable ordering key `name\u0000id`, and the
 * service keyset-queries fetch `limit + 1` rows so we can report `hasNextPage`.
 */
const DEFAULT_FIRST = 50;
const MAX_FIRST = 100;

/** Clamp a client `first` to a sane, bounded page size (defends the complexity budget). */
export function clampFirst(first?: number | null): number {
  if (first == null || !Number.isFinite(first) || first <= 0) return DEFAULT_FIRST;
  return Math.min(Math.floor(first), MAX_FIRST);
}

export function encodeCursor(name: string, id: string): string {
  return Buffer.from(`${name}\u0000${id}`, 'utf8').toString('base64url');
}

export interface After {
  afterName: string;
  afterId: string;
}
/** Decode a cursor to its (name, id) key. Absent/malformed ⇒ ('', '') = the first page
 *  (every tag name is non-empty, so `name > ''` admits all rows). */
export function decodeAfter(cursor?: string | null): After {
  if (!cursor) return { afterName: '', afterId: '' };
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const nul = raw.indexOf('\u0000');
  if (nul === -1) return { afterName: '', afterId: '' };
  return { afterName: raw.slice(0, nul), afterId: raw.slice(nul + 1) };
}

export interface TagConnectionShape {
  edges: { cursor: string; node: TagRow }[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

/** Build a Relay connection from a `limit + 1` keyset result. */
export function buildTagConnection(rowsPlusOne: TagRow[], limit: number, totalCount: number): TagConnectionShape {
  const hasNextPage = rowsPlusOne.length > limit;
  const rows = hasNextPage ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const edges = rows.map((node) => ({ cursor: encodeCursor(node.name, node.id), node }));
  return {
    edges,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false, // forward-only in the pilot
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
    },
    totalCount,
  };
}

// --- id-keyed connections (Phase W · W3.3b: TaskType). The tag connections order by
// `name id`; tasks order by `id` alone (UUIDv7 is time-ordered, so id order is a stable
// creation order — a single-column keyset, so the cursor is just the id, base64url'd. ---

/** Opaque cursor for an id-keyed connection = base64url(id). */
export function encodeIdCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
/** Decode an id cursor; absent/malformed ⇒ '' (before every id → the first page). */
export function decodeIdCursor(cursor?: string | null): string {
  if (!cursor) return '';
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

// --- (started_at, id) compound-keyed connection (Phase W · W12: JobRunConnection). Runs
// order newest-first by (started_at DESC, id DESC): UUIDv7 ids are only ms-ordered, so a
// same-second burst needs the id tie-break. The cursor packs both keys, ' ' separated (an
// ISO timestamp has no space; a UUID has none either → unambiguous). ---

export interface StartedAtCursor { startedAt: string; id: string }

export function encodeStartedAtCursor(startedAt: string, id: string): string {
  return Buffer.from(`${startedAt} ${id}`, 'utf8').toString('base64url');
}
/** Decode a (started_at, id) cursor; absent/malformed ⇒ null (⇒ the first page). */
export function decodeStartedAtCursor(cursor?: string | null): StartedAtCursor | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sp = raw.indexOf(' ');
  if (sp === -1) return null;
  return { startedAt: raw.slice(0, sp), id: raw.slice(sp + 1) };
}

/** Build a Relay connection from a `limit + 1` (started_at, id)-keyset result. Forward-only. */
export function buildStartedAtConnection<T extends { id: string; started_at: string | null }>(
  rowsPlusOne: T[],
  limit: number,
  totalCount: number,
): IdConnectionShape<T> {
  const hasNextPage = rowsPlusOne.length > limit;
  const rows = hasNextPage ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const edges = rows.map((node) => ({ cursor: encodeStartedAtCursor(node.started_at ?? '', node.id), node }));
  return {
    edges,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false, // forward-only in the pilot
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
    },
    totalCount,
  };
}

export interface IdConnectionShape<T> {
  edges: { cursor: string; node: T }[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

/** Build a Relay connection from a `limit + 1` id-keyset result. Forward-only. */
export function buildIdConnection<T extends { id: string }>(
  rowsPlusOne: T[],
  limit: number,
  totalCount: number,
): IdConnectionShape<T> {
  const hasNextPage = rowsPlusOne.length > limit;
  const rows = hasNextPage ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const edges = rows.map((node) => ({ cursor: encodeIdCursor(node.id), node }));
  return {
    edges,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false, // forward-only in the pilot
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
    },
    totalCount,
  };
}
