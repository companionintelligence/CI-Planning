import { describe, it, expect } from 'vitest';
import { shouldShowConnectCTA, hasConnectedSource } from './onboarding.js';
import type { Integrations } from './api.js';

const base: Integrations = {
  ollama: { available: false, models: [], fastModel: '', qualityModel: '', embedModel: '' },
  google: { mode: 'off', liveEnabled: false, source: 'off', connections: [] },
};

describe('hasConnectedSource / shouldShowConnectCTA', () => {
  it('undefined (still loading) → hasConnectedSource false, CTA hidden (fail-closed)', () => {
    expect(hasConnectedSource(undefined)).toBe(false);
    expect(shouldShowConnectCTA(undefined)).toBe(false);
  });

  it('no connections, mode off → no source, CTA shown', () => {
    expect(hasConnectedSource(base)).toBe(false);
    expect(shouldShowConnectCTA(base)).toBe(true);
  });

  it('one connected account → has a source, CTA hidden', () => {
    const withConn: Integrations = {
      ...base,
      google: { ...base.google, connections: [
        { provider: 'google', account: 'a@x.com', status: 'connected', expiresAt: null, mappedEventCount: 0, lastSyncAt: null, lastError: null },
      ] },
    };
    expect(hasConnectedSource(withConn)).toBe(true);
    expect(shouldShowConnectCTA(withConn)).toBe(false);
  });

  it('an expired/inactive-only connection is NOT a connected source', () => {
    const stale: Integrations = {
      ...base,
      google: { ...base.google, connections: [
        { provider: 'google', account: 'a@x.com', status: 'expired', expiresAt: null, mappedEventCount: 0, lastSyncAt: null, lastError: 'token expired' },
      ] },
    };
    expect(hasConnectedSource(stale)).toBe(false);
    expect(shouldShowConnectCTA(stale)).toBe(true);
  });

  it('fixture mode (no connections) counts as a source; CTA hidden', () => {
    const fixture: Integrations = { ...base, google: { ...base.google, mode: 'fixture' } };
    expect(hasConnectedSource(fixture)).toBe(true);
    expect(shouldShowConnectCTA(fixture)).toBe(false);
  });
});
