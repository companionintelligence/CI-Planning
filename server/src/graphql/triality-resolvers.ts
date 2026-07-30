import { GraphQLError } from 'graphql';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { trialityEnabled } from '../lib/flags.js';
import { writeAudit } from '../lib/audit.js';
import { trialityNext, logShown, stampOutcome, isOutcome, type ScoredPick } from '../services/triality.js';

/**
 * Triality GraphQL resolvers (T5) — parity with routes/triality.ts by shared
 * service layer (Decision 3: resolvers call services, never re-implement).
 * Behavior table mirrored case-for-case: flag-off gate, typed refusal,
 * shown-rows-are-events, once-only stamping, foreign-id NOT_FOUND, and the
 * WHO rule (the query never audits; a landing stamp audits once).
 */

function gate(): string {
  const owner = currentOwnerId();
  if (!trialityEnabled(owner)) {
    // The REST 404 posture: a disabled feature's surface looks absent, not broken.
    throw new GraphQLError('Not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return owner;
}

const pickToNode = (p: ScoredPick, logId: string | null) => ({
  slot: p.slot.toUpperCase(),
  actionKind: p.kind.toUpperCase(),
  actionRef: p.ref,
  title: p.title,
  estimateMin: p.estimateMin,
  direction: p.direction,
  categories: p.categories,
  motivation: p.motivation ? p.motivation.toUpperCase() : null,
  scores: {
    f: p.scores.F, h: p.scores.H, q: p.scores.Q,
    n: p.scores.N, c: p.scores.C, total: p.scores.total,
  },
  ternary: p.ternary,
  logId,
});

export const trialityResolvers = {
  Query: {
    trialityNext: async () => {
      const owner = gate();
      const now = new Date();
      const res = await trialityNext(owner, now);
      if (res.refused) {
        return {
          refused: { reason: res.refused, have: res.have, need: res.need },
          picks: null,
          emptyReasons: null,
          vector: null,
          computedAt: null,
        };
      }
      const logIds = logShown(owner, now, res.picks);
      return {
        refused: null,
        picks: res.picks.map((p, i) => (p ? pickToNode(p, logIds[i]) : null)),
        emptyReasons: res.emptyReasons,
        vector: res.vector,
        computedAt: now,
      };
    },
  },
  Mutation: {
    trialityFeedback: (_: unknown, args: { logId: string; outcome: string }) => {
      const owner = gate();
      const outcome = String(args.outcome).toLowerCase();
      if (!isOutcome(outcome)) {
        throw new GraphQLError('outcome must be OPENED, STAGED, or DISMISSED', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const mine = sqlite
        .prepare(`SELECT 1 FROM triality_log WHERE id = ? AND owner_id = ?`)
        .get(args.logId, owner);
      if (!mine) throw new GraphQLError('Not found', { extensions: { code: 'NOT_FOUND' } });

      const res = stampOutcome(owner, args.logId, outcome, new Date());
      if (res.changed) {
        writeAudit({ ownerId: owner, actor: 'owner', action: 'feedback', entity: `triality:${args.logId}` });
      }
      return { changed: res.changed, success: true };
    },
  },
};
