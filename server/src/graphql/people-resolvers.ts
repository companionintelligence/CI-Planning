import { currentOwnerId } from '../lib/context.js';
import { listPeople, getPerson, accountRoster, type Person } from '../services/people.js';

/**
 * People on work (0151) — the directory queries plus the shared `PersonType` field
 * mapping. Like every other resolver module this calls services/people.ts rather than
 * re-implementing owner-scoping (Decision 3).
 *
 * The `responsible` / `beneficiaries` edges themselves live on TaskType and
 * TimeBlockType (task-resolvers.ts / block-resolvers.ts), next to the other fields of
 * those types; only the leaf type and the standalone queries are here.
 *
 * The service already returns the API shape (snake_case + derived `is_self`), so this
 * maps that one row shape to the SDL's camelCase — the single place the two spellings
 * meet, for both fields and every entity that carries people.
 */
export function personToGraphql(p: Person): {
  id: string; displayName: string; accountId: string | null;
  isSelf: boolean; confirmed: boolean; source: string | null; emails: string[];
} {
  return {
    id: p.id,
    displayName: p.display_name,
    accountId: p.account_id,
    isSelf: p.is_self,
    confirmed: p.confirmed,
    source: p.source,
    emails: p.emails,
  };
}

export const peopleResolvers = {
  Query: {
    people: async () => (await listPeople(currentOwnerId())).map(personToGraphql),
    person: async (_p: unknown, args: { id: string }) => {
      const row = await getPerson(currentOwnerId(), args.id);
      return row ? personToGraphql(row) : null;
    },
    // Pure read — an account becomes a directory row only when picked (the REST
    // POST /api/people/accounts/:id), so this never writes.
    accountRoster: async () =>
      (await accountRoster(currentOwnerId())).map((r) => ({
        accountId: r.account_id,
        name: r.name,
        personId: r.person_id,
      })),
  },
};
