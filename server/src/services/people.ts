import { store } from '../db/store.js';
import { newId, SYSTEM_OWNER_ID } from '../lib/ids.js';

/**
 * People on work (docs/people-on-work.md) — the owner-scoped person directory and the
 * two peer people-sets an item carries.
 *
 * ONE model, two fields. `entity_people` holds both sets distinguished only by `role`:
 *
 *   - 'responsible' — who does the work. OBSERVABLE: calendar attendees and mail
 *     headers are facts on the record, so this is resolved deterministically.
 *   - 'beneficiary' — who the work is for. A JUDGMENT: nothing in an invite says who
 *     the work benefits, so this is the model's job (services/motivation.ts already
 *     answers exactly that question, and is reused rather than duplicated).
 *
 * `tasks.motivation` is NOT hand-set any more — it is a PROJECTION of the beneficiary
 * set, recomputed on every write by {@link projectMotivation}. The Triality axis's core
 * rule survives: an EMPTY set projects NULL ("never asked"), which stays distinct from
 * 'us' (a positive claim of shared benefit). See the projection's own doc comment.
 *
 * ⚠️ TENANCY vs ACCOUNT. `people.owner_id` is tenancy — whose directory the row lives
 * in, identical in meaning to owner_id everywhere else. `people.account_id` is the
 * permissioned ACCOUNT this person *is*, when they have a login here; it is NULL for
 * most people. Both reference owners(id). Every read below filters on owner_id, never
 * account_id. `account_id = owner_id` marks the user's own row, so "is self" is DERIVED
 * and can never disagree with itself.
 *
 * SQL lives at module scope and is prepared INSIDE the functions (§5.5): a module-level
 * `store().prepare` runs at import time and throws "store not initialised" for any
 * module imported before boot installs the backend.
 */

export type PersonRole = 'responsible' | 'beneficiary';
export type PersonSource = 'user' | 'llm' | 'calendar' | 'email' | 'manual' | 'account';

/** API shape (snake_case, like every other serialized row). `is_self` is derived. */
export interface Person {
  id: string;
  display_name: string;
  account_id: string | null;
  is_self: boolean;
  confirmed: boolean;
  /** How the DIRECTORY ROW came to exist ('manual' | 'account' | 'gcal' | …). */
  source: string | null;
  emails: string[];
  /**
   * How this person came to be ON THIS ITEM ('user' | 'llm' | 'calendar' | 'email') —
   * present only on entity reads, absent on plain directory reads. Distinct from
   * `source` above: a hand-created person can be machine-attached and vice versa, and
   * the UI needs THIS one to decide whether to call a set "suggested".
   */
  attachment_source?: string | null;
}

interface PersonRow {
  id: string;
  display_name: string;
  account_id: string | null;
  owner_id: string;
  confirmed: number;
  source: string | null;
}

function toPerson(row: PersonRow, emails: string[] = [], attachmentSource?: string | null): Person {
  return {
    id: row.id,
    display_name: row.display_name,
    account_id: row.account_id,
    // DERIVED, never stored — the row is "me" exactly when it is the account of the
    // tenant whose directory it lives in.
    is_self: row.account_id != null && row.account_id === row.owner_id,
    confirmed: row.confirmed === 1,
    source: row.source,
    emails,
    ...(attachmentSource !== undefined ? { attachment_source: attachmentSource } : {}),
  };
}

/** Lowercase + trim. The single normalization for every email that enters the index. */
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Pull a bare address out of the shapes mail and calendar actually hand us:
 * `"Alex Hartman" <alex@example.com>`, `<alex@example.com>`, or `alex@example.com`.
 * Returns null for anything without a plausible `@`, so junk never reaches the index.
 */
export function parseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angle = /<([^>]+)>/.exec(raw);
  const candidate = normalizeEmail(angle ? angle[1] : raw);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

/**
 * The display name to use for an address with no directory entry: the quoted display
 * name if the header carried one, else the local part with separators tidied
 * ("alex.hartman@x.com" → "Alex Hartman"). Never invents a surname it wasn't given.
 */
export function nameFromEmail(raw: string): string {
  const quoted = /^\s*"?([^"<]+?)"?\s*</.exec(raw);
  if (quoted && quoted[1].trim()) return quoted[1].trim().slice(0, 80);
  const addr = parseEmail(raw) ?? raw;
  const local = addr.split('@')[0] ?? addr;
  return (
    local
      .replace(/[._+-]+/g, ' ')
      .replace(/\d+$/, '')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 80) || addr.slice(0, 80)
  );
}

// ── Directory reads ───────────────────────────────────────────────────────────

const SQL_LIST =
  `SELECT id, owner_id, account_id, display_name, confirmed, source FROM people
    WHERE owner_id = ? ORDER BY (account_id = owner_id) DESC, display_name COLLATE NOCASE`;
const SQL_GET =
  `SELECT id, owner_id, account_id, display_name, confirmed, source FROM people
    WHERE id = ? AND owner_id = ?`;
/**
 * person_id → addresses, for exactly the rows asked about. Scoped to the given ids
 * rather than the whole tenant index: `getPerson` reads one row, and scanning every
 * address in a directory that calendar ingest keeps growing to answer that is waste on
 * a path every create/update round-trip crosses.
 */
async function emailsByPerson(personIds: string[], owner?: string): Promise<Map<string, string[]>> {
  const byPerson = new Map<string, string[]>();
  if (personIds.length === 0) return byPerson;
  const holes = personIds.map(() => '?').join(',');
  // The owner predicate is kept even though person ids are globally unique and every
  // caller sources them from owner-scoped reads: the entity read path joins
  // entity_people → people with no owner filter of its own, so this is the one place
  // left restating the tenancy guarantee rather than assuming the write path held it.
  const rows = await store()
    .prepare(
      `SELECT person_id, email FROM person_emails
        WHERE person_id IN (${holes})${owner ? ' AND owner_id = ?' : ''} ORDER BY email`,
    )
    .all<{ person_id: string; email: string }>(...personIds, ...(owner ? [owner] : []));
  for (const r of rows) {
    const list = byPerson.get(r.person_id);
    if (list) list.push(r.email);
    else byPerson.set(r.person_id, [r.email]);
  }
  return byPerson;
}

/** Attach each row's addresses in ONE query rather than N (the directory is read hot). */
async function withEmails(rows: PersonRow[]): Promise<Person[]> {
  if (rows.length === 0) return [];
  const byPerson = await emailsByPerson(rows.map((r) => r.id), rows[0].owner_id);
  return rows.map((r) => toPerson(r, byPerson.get(r.id) ?? []));
}

/** The owner's whole directory. Self first, then alphabetical. */
export async function listPeople(owner: string): Promise<Person[]> {
  return withEmails(await store().prepare(SQL_LIST).all<PersonRow>(owner));
}

/** One person, or undefined. A cross-tenant id is invisible, never a 403. */
export async function getPerson(owner: string, id: string): Promise<Person | undefined> {
  const row = await store().prepare(SQL_GET).get<PersonRow>(id, owner);
  if (!row) return undefined;
  return (await withEmails([row]))[0];
}

/** The owner's own person row. Every install has one (migration 0151 / provisionOwner). */
export async function selfPersonId(owner: string): Promise<string | undefined> {
  const row = await store()
    .prepare(`SELECT id FROM people WHERE owner_id = ? AND account_id = ?`)
    .get<{ id: string }>(owner, owner);
  return row?.id;
}

// ── Directory writes ──────────────────────────────────────────────────────────

export interface CreatePersonInput {
  display_name: string;
  emails?: string[];
  /** Set only by {@link personForAccount} — the API never lets a client claim one. */
  account_id?: string | null;
  source?: PersonSource;
  confirmed?: boolean;
}

/**
 * Create a directory entry. `display_name` is UNIQUE per owner, so a repeat name
 * returns the EXISTING row rather than throwing — the picker's "Create <name>" row is
 * a fast path a user can easily hit twice, and a 409 there would be hostile.
 */
export async function createPerson(owner: string, input: CreatePersonInput): Promise<Person> {
  const name = input.display_name.trim().slice(0, 80);
  if (!name) throw new Error('display_name is required');

  const existing = await store()
    .prepare(`SELECT id FROM people WHERE owner_id = ? AND display_name = ?`)
    .get<{ id: string }>(owner, name);
  const id = existing?.id ?? newId();

  if (!existing) {
    await store()
      .prepare(
        `INSERT INTO people (id, owner_id, account_id, display_name, confirmed, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, owner, input.account_id ?? null, name, input.confirmed === false ? 0 : 1, input.source ?? 'manual');
  }
  await addEmails(owner, id, input.emails ?? []);
  return (await getPerson(owner, id))!;
}

/**
 * Index addresses against a person. `INSERT OR IGNORE` on the (owner, email) key means
 * an address already pointing at somebody else STAYS pointing at them — reassigning it
 * silently would rewrite history on every task that person is on. Use
 * {@link mergePeople} to move addresses deliberately.
 */
export async function addEmails(owner: string, personId: string, emails: string[]): Promise<void> {
  const ins = store().prepare(
    `INSERT OR IGNORE INTO person_emails (owner_id, person_id, email) VALUES (?, ?, ?)`,
  );
  for (const raw of emails) {
    // NO fallback to the raw string: parseEmail is the validation, and `?? raw` would
    // defeat the very invariant its doc states ("junk never reaches the index").
    // Unparseable entries are skipped, not stored.
    const email = parseEmail(raw);
    if (email) await ins.run(owner, personId, email);
  }
}

export interface UpdatePersonInput {
  display_name?: string;
  notes?: string | null;
  confirmed?: boolean;
  emails?: string[];
}

/** Patch a directory entry. Returns undefined when the id isn't the owner's. */
export async function updatePerson(
  owner: string,
  id: string,
  input: UpdatePersonInput,
): Promise<Person | undefined> {
  const existing = await store().prepare(SQL_GET).get<PersonRow>(id, owner);
  if (!existing) return undefined;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.display_name !== undefined) {
    const name = input.display_name.trim().slice(0, 80);
    if (!name) throw new Error('display_name cannot be empty');
    sets.push('display_name = ?');
    params.push(name);
  }
  if (input.notes !== undefined) { sets.push('notes = ?'); params.push(input.notes); }
  // Editing a provisional entry is the confirmation — an ingest-created row the user
  // has bothered to rename is no longer a guess.
  if (input.confirmed !== undefined) { sets.push('confirmed = ?'); params.push(input.confirmed ? 1 : 0); }
  if (sets.length) {
    params.push(id, owner);
    await store().prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`).run(...params);
  }
  if (input.emails) await addEmails(owner, id, input.emails);
  return getPerson(owner, id);
}

/**
 * Remove a directory entry. `entity_people`, `possible_task_people` and `person_emails`
 * all cascade off `people.id`, so every attachment goes with it — deleting a person the
 * user considers a mistake should not leave them named on last month's tasks.
 *
 * The SELF row is undeletable: it is what the "me" shortcut resolves to, and losing it
 * would silently break both fields.
 */
export async function deletePerson(owner: string, id: string): Promise<'deleted' | 'not_found' | 'is_self'> {
  const row = await store().prepare(SQL_GET).get<PersonRow>(id, owner);
  if (!row) return 'not_found';
  if (row.account_id != null && row.account_id === row.owner_id) return 'is_self';
  await store().prepare(`DELETE FROM people WHERE id = ? AND owner_id = ?`).run(id, owner);
  return 'deleted';
}

/**
 * Fold `mergeId` into `keepId`: move addresses and every attachment, then delete the
 * duplicate. This is the intended cure for the directory drift that provisional
 * ingest-created rows cause ("A. Hartman" and "Alex Hartman" arriving from two sources).
 *
 * `INSERT OR IGNORE` on the attachment moves is load-bearing: if BOTH people are already
 * on the same task in the same role, the merged row already exists and a plain UPDATE
 * would violate the primary key.
 */
export async function mergePeople(owner: string, keepId: string, mergeId: string): Promise<Person | undefined> {
  if (keepId === mergeId) return getPerson(owner, keepId);
  const keep = await store().prepare(SQL_GET).get<PersonRow>(keepId, owner);
  const merge = await store().prepare(SQL_GET).get<PersonRow>(mergeId, owner);
  if (!keep || !merge) return undefined;
  // Merging the self row away would destroy the "me" anchor — flip the direction and
  // keep self instead of refusing, since the user's intent (one row, not two) is clear.
  const [into, from] =
    merge.account_id != null && merge.account_id === merge.owner_id ? [merge, keep] : [keep, merge];

  await store().transaction(async () => {
    await store()
      .prepare(`UPDATE OR IGNORE person_emails SET person_id = ? WHERE person_id = ? AND owner_id = ?`)
      .run(into.id, from.id, owner);
    await store()
      .prepare(`UPDATE OR IGNORE entity_people SET person_id = ? WHERE person_id = ?`)
      .run(into.id, from.id);
    await store()
      .prepare(`UPDATE OR IGNORE possible_task_people SET person_id = ? WHERE person_id = ?`)
      .run(into.id, from.id);
    await store().prepare(`DELETE FROM people WHERE id = ? AND owner_id = ?`).run(from.id, owner);
  });
  return getPerson(owner, into.id);
}

// ── Accounts (permissioned users) ─────────────────────────────────────────────

export interface AccountRosterEntry {
  account_id: string;
  name: string;
  /** The directory row for this account, when one has been materialized already. */
  person_id: string | null;
}

/**
 * The roster the `us` shortcut pre-fills from: every permissioned account on this
 * install, sentinel excluded.
 *
 * DELIBERATELY MINIMAL — `{ account_id, name }` and nothing else. `GET /api/accounts`
 * returns email, role and `hasPassword` and is operator-only for that reason; a member
 * filling in a people field must not thereby learn everyone's address and role. This is
 * a separate, non-admin endpoint rather than a relaxation of that one.
 *
 * PURE READ. Accounts are not directory rows until someone actually picks one —
 * see {@link personForAccount}, which the client calls on that (write-shaped) action.
 * On a single-account install this returns just the user, and the picker falls back to
 * named people: `us` still means you + another person, it just has no roster to
 * pre-fill from.
 */
export async function accountRoster(owner: string): Promise<AccountRosterEntry[]> {
  return store()
    .prepare(
      `SELECT o.id AS account_id, o.name AS name, p.id AS person_id
         FROM owners o
         LEFT JOIN people p ON p.owner_id = ? AND p.account_id = o.id
        WHERE o.id <> ?
        ORDER BY (o.id = ?) DESC, o.name COLLATE NOCASE`,
    )
    .all<AccountRosterEntry>(owner, SYSTEM_OWNER_ID, owner);
}

/**
 * Find-or-create this owner's directory row for a permissioned account. Idempotent, and
 * the ONLY path that may set `account_id` — a client can never claim that one of its
 * own directory entries is an account.
 *
 * Called when the user picks somebody off the roster, so the write happens on a user
 * action rather than on a GET.
 */
export async function personForAccount(owner: string, accountId: string): Promise<Person | undefined> {
  const account = await store()
    .prepare(`SELECT id, name, email FROM owners WHERE id = ? AND id <> ?`)
    .get<{ id: string; name: string | null; email: string | null }>(accountId, SYSTEM_OWNER_ID);
  if (!account) return undefined;

  const existing = await store()
    .prepare(`SELECT id FROM people WHERE owner_id = ? AND account_id = ?`)
    .get<{ id: string }>(owner, accountId);
  if (existing) return getPerson(owner, existing.id);

  // A row that already carries this account's ADDRESS is the same human — adopt it, and
  // upgrade it from a provisional guess to a confirmed account.
  const byEmail = account.email ? await resolveByEmail(owner, account.email) : undefined;
  if (byEmail) {
    await store()
      .prepare(`UPDATE people SET account_id = ?, confirmed = 1, source = 'account' WHERE id = ? AND owner_id = ?`)
      .run(accountId, byEmail, owner);
    return getPerson(owner, byEmail);
  }

  // A NAME match is NOT identity. Adopting a same-named row would silently merge two
  // different humans — the neighbour "Chris" becoming the colleague account "Chris",
  // retroactively re-labelling every task the neighbour was on. Disambiguate instead
  // and leave merging to the explicit, reversible merge action.
  const base = (account.name ?? '').trim() || 'Unnamed';
  let name = base;
  for (let n = 2; n <= 50; n++) {
    const clash = await store()
      .prepare(`SELECT id FROM people WHERE owner_id = ? AND display_name = ?`)
      .get<{ id: string }>(owner, name);
    if (!clash) break;
    // Past the cap, fall back to something that CANNOT collide rather than looping
    // forever or handing back a name that does.
    name = n === 50 ? `${base} (${accountId.slice(0, 8)})` : `${base} (${n})`;
  }

  // INSERT directly, not via createPerson: that helper returns the EXISTING row for a
  // duplicate name and ignores account_id, so a residual collision would silently yield
  // a person with no account link while this function reported success.
  const personId = newId();
  await store()
    .prepare(
      `INSERT INTO people (id, owner_id, account_id, display_name, confirmed, source)
       VALUES (?, ?, ?, ?, 1, 'account')`,
    )
    .run(personId, owner, accountId, name);
  if (account.email) await addEmails(owner, personId, [account.email]);
  return getPerson(owner, personId);
}

// ── Email → person resolution (deterministic, no model) ───────────────────────

/**
 * Resolve an address to a person in THIS owner's directory. Owner-scoped by
 * construction: an identical address in another tenant's directory must never match,
 * or one tenant's naming would decide who another tenant's mail is from.
 */
export async function resolveByEmail(owner: string, raw: string): Promise<string | undefined> {
  const email = parseEmail(raw);
  if (!email) return undefined;
  const row = await store()
    .prepare(`SELECT person_id FROM person_emails WHERE owner_id = ? AND email = ?`)
    .get<{ person_id: string }>(owner, email);
  return row?.person_id;
}

/**
 * Resolve an address, creating a PROVISIONAL directory entry when it is unknown.
 *
 * Called only at PROMOTION, never while scanning. Ingest reads far more mail and events
 * than the user ever promotes, and creating a person for every address it passed would
 * turn the directory into a mailing-list dump inside a week. `confirmed = 0` marks the
 * row for review in Settings → People.
 */
export async function resolveOrCreateByEmail(
  owner: string,
  raw: string,
  source: PersonSource,
): Promise<string | undefined> {
  const email = parseEmail(raw);
  if (!email) return undefined;
  const found = await resolveByEmail(owner, email);
  if (found) return found;

  // Before inventing anybody: does this address belong to an ACCOUNT on this install?
  //
  // `person_emails` is only seeded from `owners.email`, and that column is routinely
  // NULL — so the owner's OWN address is frequently unresolvable. Creating a person for
  // it would mint a second, provisional, `is_self:false` "you": the motivation
  // projection would then see no self in a beneficiary set and label your own work
  // 'them'. Matching against `owners` first closes that, and does the same good turn
  // for a colleague's account address.
  // The sentinel is excluded as a PICKABLE account (it is nobody's login), but never
  // when it is the tenant themselves — under AUTH_MODE=test the sentinel IS the owner,
  // and excluding it there would reintroduce the duplicate-self bug on exactly the dev
  // loop most likely to hit it. Self wins the ordering when an address is on two rows.
  const account = await store()
    .prepare(
      `SELECT id FROM owners WHERE lower(email) = ? AND (id = ? OR id <> ?)
        ORDER BY (id = ?) DESC LIMIT 1`,
    )
    .get<{ id: string }>(email, owner, SYSTEM_OWNER_ID, owner);
  if (account) {
    // personForAccount refuses the sentinel by design, so the tenant's own row is
    // resolved directly; anyone else goes through the normal materialize path.
    const personId =
      account.id === owner
        ? await selfPersonId(owner)
        : (await personForAccount(owner, account.id))?.id;
    // Index the address so the next sighting resolves without this lookup at all.
    if (personId) { await addEmails(owner, personId, [email]); return personId; }
  }

  const person = await createPerson(owner, {
    display_name: nameFromEmail(raw),
    emails: [email],
    source,
    confirmed: false,
  });
  return person.id;
}

// ── Attachment (entity_people) ────────────────────────────────────────────────

const SQL_PEOPLE_FOR_ENTITY =
  `SELECT p.id, p.owner_id, p.account_id, p.display_name, p.confirmed, p.source AS source,
          ep.role AS role, ep.position AS position, ep.source AS attachment_source
     FROM entity_people ep
     JOIN people p ON p.id = ep.person_id
    WHERE ep.entity_kind = ? AND ep.entity_id = ?
    ORDER BY ep.role, ep.position, p.display_name COLLATE NOCASE`;

export interface EntityPeople {
  /** Position-ordered; index 0 is the lead (a display convention, not a schema rule). */
  responsible: Person[];
  beneficiaries: Person[];
}

/**
 * Both sets for one entity, addresses and attachment provenance included.
 *
 * Returns FRESH arrays every call — deliberately not `{ ...EMPTY }` off a module-level
 * constant, which is a shallow copy that hands every caller the same two array
 * instances: one caller sorting or pushing would then corrupt the "empty" result of
 * every unrelated entity for the lifetime of the process.
 */
export async function getEntityPeople(entityKind: string, entityId: string): Promise<EntityPeople> {
  const rows = await store()
    .prepare(SQL_PEOPLE_FOR_ENTITY)
    .all<PersonRow & { role: string; position: number; attachment_source: string | null }>(entityKind, entityId);
  if (rows.length === 0) return { responsible: [], beneficiaries: [] };
  const byPerson = await emailsByPerson(rows.map((r) => r.id), rows[0].owner_id);
  const build = (role: string) =>
    rows.filter((r) => r.role === role).map((r) => toPerson(r, byPerson.get(r.id) ?? [], r.attachment_source));
  return { responsible: build('responsible'), beneficiaries: build('beneficiary') };
}

/** Both sets for many entities at once — the list read path (N+1 would be brutal). */
export async function getEntityPeopleBulk(
  entityKind: string,
  entityIds: string[],
): Promise<Map<string, EntityPeople>> {
  const out = new Map<string, EntityPeople>();
  if (entityIds.length === 0) return out;
  const holes = entityIds.map(() => '?').join(',');
  const rows = await store()
    .prepare(
      `SELECT ep.entity_id AS entity_id, ep.role AS role, ep.position AS position,
              ep.source AS attachment_source,
              p.id, p.owner_id, p.account_id, p.display_name, p.confirmed, p.source AS source
         FROM entity_people ep
         JOIN people p ON p.id = ep.person_id
        WHERE ep.entity_kind = ? AND ep.entity_id IN (${holes})
        ORDER BY ep.role, ep.position, p.display_name COLLATE NOCASE`,
    )
    .all<PersonRow & { entity_id: string; role: string; position: number; attachment_source: string | null }>(
      entityKind, ...entityIds,
    );
  const byPerson = await emailsByPerson([...new Set(rows.map((r) => r.id))], rows[0]?.owner_id);
  for (const r of rows) {
    let bucket = out.get(r.entity_id);
    if (!bucket) { bucket = { responsible: [], beneficiaries: [] }; out.set(r.entity_id, bucket); }
    const person = toPerson(r, byPerson.get(r.id) ?? [], r.attachment_source);
    (r.role === 'responsible' ? bucket.responsible : bucket.beneficiaries).push(person);
  }
  return out;
}

/**
 * Replace one role's set on an entity. Position follows the given order, so the caller
 * controls who the lead is.
 *
 * Cross-tenant safe: ids are filtered through the owner's own directory first, so a
 * borrowed person id from another tenant silently drops instead of attaching.
 */
export async function setEntityPeople(
  owner: string,
  entityKind: string,
  entityId: string,
  role: PersonRole,
  personIds: string[],
  source: PersonSource = 'user',
): Promise<void> {
  const valid = await ownedPersonIds(owner, personIds);
  await store().transaction(async () => {
    await store()
      .prepare(`DELETE FROM entity_people WHERE entity_kind = ? AND entity_id = ? AND role = ?`)
      .run(entityKind, entityId, role);
    const ins = store().prepare(
      `INSERT OR IGNORE INTO entity_people (entity_kind, entity_id, person_id, role, source, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < valid.length; i++) {
      await ins.run(entityKind, entityId, valid[i], role, source, i);
    }
  });
}

/**
 * Machine attach — the `motivation_source='user'` guarantee, one level up.
 *
 * A people field is a SET, and a user who curated one owns it whole: appending a
 * machine guess to a list somebody deliberately pruned would be worse than staying
 * quiet. So the rule is all-or-nothing per (entity, role): if ANY row in that role
 * carries `source = 'user'`, this is a no-op.
 *
 * Returns whether it wrote.
 */
export async function attachMachinePeople(
  owner: string,
  entityKind: string,
  entityId: string,
  role: PersonRole,
  personIds: string[],
  source: PersonSource,
): Promise<boolean> {
  if (personIds.length === 0) return false;
  const userOwned = await store()
    .prepare(
      `SELECT 1 AS hit FROM entity_people
        WHERE entity_kind = ? AND entity_id = ? AND role = ? AND source = 'user' LIMIT 1`,
    )
    .get<{ hit: number }>(entityKind, entityId, role);
  if (userOwned) return false;
  await setEntityPeople(owner, entityKind, entityId, role, personIds, source);
  return true;
}

/** Filter ids to those in the owner's directory, preserving the caller's order. */
async function ownedPersonIds(owner: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  if (unique.length === 0) return [];
  const holes = unique.map(() => '?').join(',');
  const rows = await store()
    .prepare(`SELECT id FROM people WHERE owner_id = ? AND id IN (${holes})`)
    .all<{ id: string }>(owner, ...unique);
  const ok = new Set(rows.map((r) => r.id));
  return unique.filter((id) => ok.has(id));
}

// ── The motivation projection ─────────────────────────────────────────────────

export type Motivation = 'me' | 'us' | 'them';

/**
 * Project a beneficiary set onto the Triality motivation axis.
 *
 *   {}                    → null   — unlabeled. NEVER 'us'.
 *   { self }              → 'me'
 *   { self, ...others }   → 'us'
 *   { ...others }         → 'them'
 *
 * The empty case is the axis's core correctness rule (0141): "shared benefit" is a
 * positive claim, "never asked" is the absence of one, and the metrics must be able to
 * tell them apart even though scoring collapses both to 0.
 *
 * Reading the SET rather than a mode button is what keeps this honest however the set
 * was assembled: "me and my wife", where the wife has no login, projects 'us' exactly as
 * a roomful of accounts does. Accounts make the set easier to fill; they never gate what
 * the axis can express.
 */
export function projectMotivation(beneficiaryIds: string[], selfId: string | undefined): Motivation | null {
  if (beneficiaryIds.length === 0) return null;
  const hasSelf = selfId != null && beneficiaryIds.includes(selfId);
  if (!hasSelf) return 'them';
  return beneficiaryIds.length === 1 ? 'me' : 'us';
}

const SQL_BENEFICIARY_IDS =
  `SELECT person_id, source FROM entity_people
    WHERE entity_kind = 'task' AND entity_id = ? AND role = 'beneficiary'`;

/**
 * Recompute `tasks.motivation` from the task's current beneficiary set and write it.
 * Call after EVERY beneficiary write; it is the only thing that sets the column now.
 *
 * `motivation_source` follows the set's provenance — a user-curated set is user
 * testimony, a detected one is machine testimony — which keeps the existing
 * "a user value is permanent" guard in services/motivation.ts meaningful without it
 * having to know people exist.
 */
export async function applyMotivationProjection(owner: string, taskId: string): Promise<Motivation | null> {
  const rows = await store()
    .prepare(SQL_BENEFICIARY_IDS)
    .all<{ person_id: string; source: string | null }>(taskId);
  const self = await selfPersonId(owner);
  const value = projectMotivation(rows.map((r) => r.person_id), self);
  const source = value === null ? null : rows.some((r) => r.source === 'user') ? 'user' : 'llm';
  await store()
    .prepare(`UPDATE tasks SET motivation = ?, motivation_source = ? WHERE id = ? AND owner_id = ?`)
    .run(value, source, taskId, owner);
  return value;
}
