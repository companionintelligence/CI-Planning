import { createSignal } from 'solid-js';

export interface ConflictRecord {
  id: string;
  entity: 'task' | 'block' | 'objective' | 'objective_task';
  entityId: string;
  entityTitle: string;
  fields: string[];
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
