import { createSignal } from 'solid-js';

/**
 * Why an edit needs the owner's attention.
 *
 * 'overwritten' — the op applied, but these fields lost a last-write-wins race
 *   against another device. The server's value is live; "Keep mine" re-sends.
 * 'rejected'    — the server refused the op outright (validation, a stale target,
 *   a constraint). Nothing of it applied. Retrying unchanged would fail the same
 *   way forever, so the op leaves the outbox — but the edit must not disappear
 *   without the owner hearing about it, which is what this kind exists to say.
 *
 * Defaults to 'overwritten' when absent: that was the only case before rejected
 * edits were surfaced, and every existing producer means it.
 */
export type ConflictKind = 'overwritten' | 'rejected';

export interface ConflictRecord {
  id: string;
  entity: 'task' | 'block' | 'objective' | 'objective_task';
  entityId: string;
  entityTitle: string;
  fields: string[];
  kind?: ConflictKind;
  recover: () => void;
}

const [conflicts, setConflicts] = createSignal<ConflictRecord[]>([]);
export { conflicts };

export function addConflict(record: ConflictRecord): void {
  setConflicts((prev) => [...prev, record]);
}

export function resolveConflict(id: string): void {
  setConflicts((prev) => prev.filter((c) => c.id !== id));
}

export function resolveAllConflicts(): void {
  setConflicts([]);
}
