import { describe, it, expect, beforeEach } from 'vitest';
import { conflicts, addConflict, resolveConflict, resolveAllConflicts, type ConflictRecord } from './conflicts.js';

function makeRecord(id: string, fields = ['title']): ConflictRecord {
  return {
    id,
    entity: 'task',
    entityId: `task-${id}`,
    entityTitle: `Task ${id}`,
    fields,
    recover: () => {},
  };
}

describe('conflicts store', () => {
  beforeEach(() => resolveAllConflicts());

  it('starts empty', () => {
    expect(conflicts()).toEqual([]);
  });

  it('addConflict appends a record', () => {
    addConflict(makeRecord('a'));
    expect(conflicts()).toHaveLength(1);
    expect(conflicts()[0].id).toBe('a');
  });

  it('addConflict appends multiple records in order', () => {
    addConflict(makeRecord('a'));
    addConflict(makeRecord('b'));
    expect(conflicts().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('resolveConflict removes by id', () => {
    addConflict(makeRecord('a'));
    addConflict(makeRecord('b'));
    resolveConflict('a');
    expect(conflicts()).toHaveLength(1);
    expect(conflicts()[0].id).toBe('b');
  });

  it('resolveConflict is a no-op for unknown id', () => {
    addConflict(makeRecord('a'));
    resolveConflict('ghost');
    expect(conflicts()).toHaveLength(1);
  });

  it('resolveAllConflicts clears everything', () => {
    addConflict(makeRecord('a'));
    addConflict(makeRecord('b'));
    resolveAllConflicts();
    expect(conflicts()).toEqual([]);
  });

  it('recover callback is stored and callable', () => {
    let called = false;
    const rec = { ...makeRecord('a'), recover: () => { called = true; } };
    addConflict(rec);
    conflicts()[0].recover();
    expect(called).toBe(true);
  });

  it('entityTitle and fields are preserved', () => {
    addConflict(makeRecord('a', ['status', 'priority']));
    expect(conflicts()[0].entityTitle).toBe('Task a');
    expect(conflicts()[0].fields).toEqual(['status', 'priority']);
  });
});
