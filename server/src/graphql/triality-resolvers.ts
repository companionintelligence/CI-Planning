import { GraphQLError } from 'graphql';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { trialityEnabled } from '../lib/flags.js';
import { writeAudit } from '../lib/audit.js';
import { trialityNext, logShown, stampOutcome, isOutcome, type ScoredPick } from '../services/triality.js';
import { attachRationales, type Rationale } from '../services/triality-rationale.js';
import { attachConfidence, serializeConfidence, type PickConfidence } from '../services/triality-confidence.js';

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

// T9 parity: the same garnish, attached the same way (after the engine), with the
// wire style this file already uses — camelCase fields, SCREAMING enum values.
const pickToNode = (
  p: ScoredPick,
  logId: string | null,
  rationale: Rationale,
  confidence: PickConfidence,
) => ({
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
  rationale: rationale.text,
  rationaleSource: rationale.source.toUpperCase(),
  // v2.2 parity: the same numbers the REST route ships, in this file's wire style.
  // Typed on the schema rather than smuggled through the untyped `vector` JSON scalar,
  // where it would need no SDL change and would therefore skip review.
  confidence: {
    ...confidence,
    band: confidence.band.toUpperCase(),
    marginBasis: confidence.marginBasis.toUpperCase(),
    binding: confidence.binding.toUpperCase(),
  },
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
      // Same three-call ordering as routes/triality.ts — confidence is stamped at show
      // time, so it is computed before the insert.
      const confidences = attachConfidence(res.picks, res.vector);
      const logIds = await logShown(owner, now, res.picks, confidences.map(serializeConfidence));
      const rationales = await attachRationales(res.picks, res.vector);
      return {
        refused: null,
        picks: res.picks.map((p, i) => (p ? pickToNode(p, logIds[i], rationales[i]!, confidences[i]!) : null)),
        emptyReasons: res.emptyReasons,
        vector: res.vector,
        computedAt: now,
      };
    },
  },
  Mutation: {
    trialityFeedback: async (_: unknown, args: { logId: string; outcome: string }) => {
      const owner = gate();
      const outcome = String(args.outcome).toLowerCase();
      if (!isOutcome(outcome)) {
        throw new GraphQLError('outcome must be OPENED, STAGED, or DISMISSED', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const mine = await store()
        .prepare(`SELECT 1 FROM triality_log WHERE id = ? AND owner_id = ?`)
        .get(args.logId, owner);
      if (!mine) throw new GraphQLError('Not found', { extensions: { code: 'NOT_FOUND' } });

      const res = await stampOutcome(owner, args.logId, outcome, new Date());
      if (res.changed) {
        writeAudit({ ownerId: owner, actor: 'owner', action: 'feedback', entity: `triality:${args.logId}` });
      }
      return { changed: res.changed, success: true };
    },
  },
};
