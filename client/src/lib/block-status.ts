/**
 * What a block's status means to the views.
 *
 * The server's `TERMINAL_BLOCK_STATUSES` (services/block-task-sync.ts) is the authority:
 * a settled block is history, not live work, and is filtered out of reflow, conflicts,
 * budget, and placement there. The client has to answer identically or the two disagree
 * about what is still on the board — so this list is the single client-side mirror of it
 * rather than a literal repeated per component.
 *
 * `isSettled` is deliberately broader than "done": cancelled and missed blocks are
 * settled history but were never completed, and folding them together is what would make
 * an abandoned task read as a finished one.
 */

/** Mirror of the server's TERMINAL_BLOCK_STATUSES. */
export const SETTLED_BLOCK: ReadonlySet<string> = new Set(['completed', 'skipped', 'cancelled', 'missed']);

/** Settled — terminal history rather than live work, whatever the outcome was. */
export const isSettled = (status: string): boolean => SETTLED_BLOCK.has(status);

/** Finished on purpose. Narrower than `isSettled`: cancelled/missed never read as done. */
export const isCompleted = (status: string): boolean => status === 'completed' || status === 'skipped';
