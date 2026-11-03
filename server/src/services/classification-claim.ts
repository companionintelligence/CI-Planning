import { logger } from '../lib/logger.js';
import { constrainToVocabulary } from '../agents/constrain.js';
import { suggestibleVocabulary } from './tags.js';
import { classificationInput, logAnsweredAssignment, type EntityKind } from './classification-learning.js';

/**
 * Settle the wizard's preview claim once its task (or Time Block, `entityKind`) exists: the model's category pick
 * (shown in the preview, echoed by the client as `classification_claim`) against what the
 * owner actually saved. Called after a SUCCESSFUL create only, so nothing is written for a
 * failed one, and never on the zero-write parse route, so an abandoned preview is never
 * evidence of acceptance. At most one row, category only: the wizard neither shows nor
 * sends motivation.
 *
 * TRUST BOUNDARY. The claim is client-attested, not server-verified; it is deliberately
 * unsigned. Everything that matters is taken from the server instead: the owner is the
 * caller, the id and title are the row just created, the names must be in the caller's
 * own suggestible vocabulary, the claimed text must equal that task's own title, and the
 * final value is READ BACK from the database rather than echoed. So a forged claim only ever
 * affects the caller's OWN evidence: at most one row in the caller's own log, about the task
 * the caller just created, with that task's title and the caller's own category names. The
 * caller can choose the claimed value (the model's side of the lesson), which is acceptable
 * because they already own the corrections they could make by hand. Nothing here reaches
 * another owner. Contrast `motivation_source`, which the route strips because a forged 'llm'
 * would relabel task data other systems read; a claim only ever feeds the caller's own
 * prompt hints.
 *
 * Nothing about the claim is ever an error. A claim that fails a check is dropped, the task
 * is created as it would be without one, and the reason is debug-logged. Debug lines print
 * only at LOG_LEVEL=debug, so counting the loss needs that level; there is no counter (log
 * keys are reason and err only; SECRET_KEY_RE redacts any key containing "iv" or "code").
 * The whole helper is best-effort: a broken log table must not fail the create.
 */
export async function settlePreviewClaim(
  owner: string,
  task: { id: string; title: string },
  rawClaim: unknown,
  sent: unknown,
  saved: string[],
  entityKind: EntityKind = 'task',
): Promise<void> {
  if (rawClaim === undefined) return; // no claim: the ordinary case, nothing to say
  const drop = (reason: 'shape' | 'no-categories-sent' | 'title' | 'vocabulary' | 'not-saved'): void => {
    logger.debug('classification-learning: preview claim dropped', { reason });
  };
  try {
    // Shape. Length is checked before anything iterates, so a hostile array is dropped
    // without being walked. Keys beyond text and categories are never read.
    if (!rawClaim || typeof rawClaim !== 'object' || Array.isArray(rawClaim)) return drop('shape');
    const { text, categories } = rawClaim as { text?: unknown; categories?: unknown };
    if (typeof text !== 'string' || text.length < 1 || text.length > 500) return drop('shape');
    if (!Array.isArray(categories) || categories.length < 1 || categories.length > 3
        || !categories.every((c) => typeof c === 'string')) return drop('shape');

    // `undefined` means "leave the categories alone", not "the owner chose none": only a
    // caller who sent a list (an empty one is the cleared picker) gave an answer.
    if (!Array.isArray(sent)) return drop('no-categories-sent');

    // Strict title binding, no case or whitespace folding beyond classificationInput's own
    // trim: it can only under-record, never record a claim about some other text.
    const input = classificationInput(task.title, null);
    if (!input || input !== classificationInput(text, null)) return drop('title');

    // All or nothing: an unknown, muted, other-owner, duplicate or renamed name changes
    // the count and drops the whole claim. The stored value takes the vocabulary's casing.
    const vocab = await suggestibleVocabulary(owner);
    const picked = constrainToVocabulary(categories, vocab.categories, 3);
    if (picked.length !== categories.length) return drop('vocabulary');

    // Names were sent but none landed (all unknown to createTask): there is no answer to
    // record, and recording "nothing" would invent one.
    if (sent.length > 0 && saved.length === 0) return drop('not-saved');

    await logAnsweredAssignment(owner, {
      taskId: task.id, field: 'category', inputText: input, llmValue: picked, finalValue: saved, entityKind,
    });
  } catch (err) {
    logger.warn('classification-learning: could not settle preview claim', { err: (err as Error).message });
  }
}
