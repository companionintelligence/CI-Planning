import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeAudit, flushAudits } from '../src/lib/audit.js';
import { logger } from '../src/lib/logger.js';
import { resetDb } from './helpers.js';

/**
 * writeAudit's failure path used to be silent — the catch on its INSERT swallowed
 * everything with no log line at all. For a security-relevant, write-only-in-production
 * record, "we don't know this event is missing" is worse than the loss itself.
 *
 * `audit_log.owner_id` has an ENFORCED foreign key (owners(id); db/open.ts turns on
 * `foreign_keys` and db-open-fk.test.ts pins that contract), so a nonexistent owner_id
 * is a clean, natural way to make ONE insert genuinely fail without touching the store
 * singleton or disturbing any other test.
 */

beforeEach(() => resetDb());

describe('writeAudit — a failed write is no longer silent', () => {
  it('logs loudly, naming the action, instead of vanishing with no trace', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    writeAudit({ ownerId: 'no-such-owner', actor: 'owner', action: 'test_action', entity: 'x:1' });
    await flushAudits();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg, meta] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/audit write failed/i);
    expect(meta).toMatchObject({ ownerId: 'no-such-owner', action: 'test_action' });
    expect(typeof meta.err).toBe('string'); // the underlying DB error, not just "it broke"

    errorSpy.mockRestore();
  });

  it('still never throws to the caller — the fire-and-forget contract is unchanged', async () => {
    expect(() =>
      writeAudit({ ownerId: 'no-such-owner-2', actor: 'owner', action: 'test_action', entity: 'x:2' }),
    ).not.toThrow();
    // Must resolve cleanly, not reject or hang — flushAudits is the ONLY thing that
    // ever awaits this write, and it must stay usable after a failure too.
    await expect(flushAudits()).resolves.toBeUndefined();
  });

  it('a genuinely successful write logs nothing at error level', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const { SYSTEM_OWNER } = await import('../src/lib/context.js');

    writeAudit({ ownerId: SYSTEM_OWNER, actor: 'owner', action: 'test_action', entity: 'x:3' });
    await flushAudits();

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
