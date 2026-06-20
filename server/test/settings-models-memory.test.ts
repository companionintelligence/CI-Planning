import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { config } from '../src/lib/config.js';
import { resolveModel, resolveEmbedModel } from '../src/lib/models.js';
import { memoryStatus, syncToMemory } from '../src/services/memory.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Settings (Phase: model picker + Companion Memory sync). Covers per-owner model
 * resolution (override → env fallback), the memory service guard/state machine
 * (off / not connected / connector-unavailable), and the prefs API round-trip of
 * the new columns.
 */

const OWNER = SYSTEM_OWNER;

function setPrefs(fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  sqlite.prepare(`UPDATE scheduling_prefs SET ${set} WHERE owner_id = ?`).run(...keys.map((k) => fields[k]), OWNER);
}

beforeEach(() => {
  resetDb(); // keeps scheduling_prefs — reset the new columns to defaults explicitly
  setPrefs({
    fast_model: null, quality_model: null, embed_model: null,
    memory_sync_enabled: 0, memory_account: null, memory_last_synced_at: null,
    memory_sync_completed: 1, memory_sync_habits: 1, memory_sync_reflections: 1,
  });
});

describe('model resolution', () => {
  it('falls back to env defaults when no override is set', () => {
    expect(resolveModel('small', OWNER)).toBe(config.ollamaSmallModel);
    expect(resolveModel('medium', OWNER)).toBe(config.ollamaMediumModel);
    expect(resolveEmbedModel(OWNER)).toBe(config.ollamaEmbedModel);
  });

  it('uses the per-owner override when set', () => {
    setPrefs({ fast_model: 'fast-x', quality_model: 'quality-y', embed_model: 'embed-z' });
    expect(resolveModel('small', OWNER)).toBe('fast-x');
    expect(resolveModel('medium', OWNER)).toBe('quality-y');
    expect(resolveEmbedModel(OWNER)).toBe('embed-z');
  });

  it('treats a blank override as "use the default"', () => {
    setPrefs({ fast_model: '   ' });
    expect(resolveModel('small', OWNER)).toBe(config.ollamaSmallModel);
  });
});

describe('memory service', () => {
  it('defaults: off, not connected, connector unavailable, scopes on', () => {
    const s = memoryStatus(OWNER);
    expect(s).toMatchObject({ enabled: false, connected: false, available: false });
    expect(s.scopes).toEqual({ completed: true, habits: true, reflections: true });
  });

  it('reflects enabled + account + a narrowed scope', () => {
    setPrefs({ memory_sync_enabled: 1, memory_account: 'liam@x.io', memory_sync_reflections: 0 });
    const s = memoryStatus(OWNER);
    expect(s).toMatchObject({ enabled: true, connected: true, account: 'liam@x.io' });
    expect(s.scopes.reflections).toBe(false);
  });

  it('syncToMemory guards: disabled → not_connected → unavailable', () => {
    expect(syncToMemory(OWNER)).toEqual({ ok: false, reason: 'disabled' });
    setPrefs({ memory_sync_enabled: 1 });
    expect(syncToMemory(OWNER)).toEqual({ ok: false, reason: 'not_connected' });
    setPrefs({ memory_account: 'liam@x.io' });
    expect(syncToMemory(OWNER)).toEqual({ ok: false, reason: 'unavailable' }); // connector stubbed
  });
});

describe('routes', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it('GET /api/memory/status returns the panel shape', async () => {
    const { status, body } = await api(srv.url, '/api/memory/status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: false, connected: false, available: false });
    expect(body.scopes).toBeDefined();
  });

  it('PATCH /api/prefs round-trips the new model + memory fields', async () => {
    const patch = await api(srv.url, '/api/prefs', {
      method: 'PATCH',
      json: { fast_model: 'qwen3.5:9b', memory_sync_enabled: true, memory_sync_reflections: false },
    });
    expect(patch.status).toBe(200);
    const get = await api(srv.url, '/api/prefs');
    expect(get.body.prefs.fast_model).toBe('qwen3.5:9b');
    expect(get.body.prefs.memory_sync_enabled).toBe(true);
    expect(get.body.prefs.memory_sync_reflections).toBe(false);
  });

  it('POST /api/memory/sync: 400 when off, 503 when connected (connector pending)', async () => {
    const off = await api(srv.url, '/api/memory/sync', { method: 'POST' });
    expect(off.status).toBe(400);

    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_sync_enabled: true, memory_account: 'liam@x.io' } });
    const conn = await api(srv.url, '/api/memory/sync', { method: 'POST' });
    expect(conn.status).toBe(503);
    expect(conn.body.reason).toBe('unavailable');
  });
});
