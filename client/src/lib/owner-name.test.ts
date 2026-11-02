import { describe, it, expect } from 'vitest';
import { editableOwnerName, SEEDED_OWNER_NAME } from './owner-name.js';

describe('editableOwnerName', () => {
  it('opens empty for the seeded placeholder, so the owner is asked for a name', () => {
    expect(editableOwnerName(SEEDED_OWNER_NAME)).toBe('');
    expect(editableOwnerName(' System ')).toBe('');
  });

  it('keeps a name the owner chose, trimmed', () => {
    expect(editableOwnerName('  Liam Broza ')).toBe('Liam Broza');
    expect(editableOwnerName('Systems')).toBe('Systems');
  });

  it('is empty when there is no name at all', () => {
    expect(editableOwnerName(null)).toBe('');
    expect(editableOwnerName(undefined)).toBe('');
  });
});
