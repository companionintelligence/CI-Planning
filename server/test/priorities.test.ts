import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';

describe('Life priorities API & scheduler balancing', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.close());
  beforeEach(() => {
    resetDb();
    // Ensure priorities is reset / seeded properly
    sqlite.exec(`
      DELETE FROM life_priorities;
      INSERT INTO life_priorities (category, satisfaction, importance, target_hours_per_week) VALUES
        ('health', 5, 5, 10),
        ('career', 5, 5, 10),
        ('relationships', 5, 5, 10),
        ('growth', 5, 5, 10),
        ('leisure', 5, 5, 10),
        ('finance', 5, 5, 10);
    `);
  });

  it('lists default priorities', async () => {
    const res = await api(server.url, '/api/priorities');
    expect(res.status).toBe(200);
    expect(res.body.priorities.length).toBe(6);
    const health = res.body.priorities.find((p: any) => p.category === 'health');
    expect(health.satisfaction).toBe(5);
    expect(health.importance).toBe(5);
    expect(health.target_hours_per_week).toBe(10);
  });

  it('updates priorities', async () => {
    const updateRes = await api(server.url, '/api/priorities', {
      method: 'POST',
      json: {
        priorities: [
          { category: 'health', satisfaction: 8, importance: 9, target_hours_per_week: 15 },
          { category: 'career', satisfaction: 4, importance: 8, target_hours_per_week: 35 },
        ]
      }
    });

    expect(updateRes.status).toBe(200);
    const health = updateRes.body.priorities.find((p: any) => p.category === 'health');
    expect(health.satisfaction).toBe(8);
    expect(health.importance).toBe(9);
    expect(health.target_hours_per_week).toBe(15);

    // Get list to verify persistence
    const res = await api(server.url, '/api/priorities');
    const career = res.body.priorities.find((p: any) => p.category === 'career');
    expect(career.satisfaction).toBe(4);
    expect(career.importance).toBe(8);
    expect(career.target_hours_per_week).toBe(35);
  });

  it('balances task priorities dynamically in the scheduler based on category deficit', async () => {
    // 1. Create two priority 3 tasks (one career, one health)
    const taskCareer = await api(server.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Career Task', priority: 3, estimated_minutes: 60, category: 'career' }
    });
    const taskHealth = await api(server.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Health Task', priority: 3, estimated_minutes: 60, category: 'health' }
    });

    // 2. Set targets: career = 10h, health = 10h
    await api(server.url, '/api/priorities', {
      method: 'POST',
      json: {
        priorities: [
          { category: 'career', satisfaction: 5, importance: 5, target_hours_per_week: 10 },
          { category: 'health', satisfaction: 5, importance: 5, target_hours_per_week: 10 },
        ]
      }
    });

    // 3. Simulate existing scheduled blocks this week for career, making health have a higher deficit.
    // We add a time block of 2 hours (120 min) for career.
    const mockCareerTaskId = taskCareer.body.task.id;
    sqlite.prepare(`
      INSERT INTO time_blocks (task_id, title, block_kind, start_at, end_at, is_locked, is_auto, status)
      VALUES (?, 'Mock Work', 'task', '2026-06-01T08:00:00.000Z', '2026-06-01T10:00:00.000Z', 1, 0, 'planned')
    `).run(mockCareerTaskId);

    // 4. Run the scheduler for 2026-06-01.
    // Because career has actual hours (2h), its deficit is 8h.
    // Health has 0h actual hours, its deficit is 10h.
    // Thus health task gets a higher boost and should be scheduled first!
    const runRes = await api(server.url, '/api/schedule/run', {
      method: 'POST',
      json: { date: '2026-06-01' }
    });
    expect(runRes.status).toBe(200);

    // Get scheduled blocks on 2026-06-01 and verify health is scheduled first.
    const blocksRes = await api(server.url, '/api/blocks?from=2026-06-01T00:00:00.000Z&to=2026-06-01T23:59:59.000Z');
    
    // Sort blocks by start time to trace execution order
    const autoBlocks = blocksRes.body.blocks
      .filter((b: any) => b.is_auto && b.block_kind === 'task')
      .sort((a: any, b: any) => a.start_at.localeCompare(b.start_at));

    expect(autoBlocks.length).toBe(2);
    // The health task should be the first automatically scheduled task block because its deficit boost made it higher priority!
    expect(autoBlocks[0].task_id).toBe(taskHealth.body.task.id);
    expect(autoBlocks[1].task_id).toBe(taskCareer.body.task.id);
  });
});
