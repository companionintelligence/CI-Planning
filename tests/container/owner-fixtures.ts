import { expect, type APIRequestContext, type Page } from '@playwright/test';

const appUrl = () => (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '');

/** Sign into a local-login fixture and finish onboarding using persisted state. */
export async function signInLocal(page: Page, baseUrl = appUrl()): Promise<void> {
  const me = await page.request.get(`${baseUrl}/api/auth/me`);
  if (me.status() !== 200) {
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    const localLogin = page.getByRole('button', { name: /sign in with username instead/i });
    if (await localLogin.isVisible().catch(() => false)) await localLogin.click();
    await page.getByLabel(/^username/i).fill(process.env.LOGIN_USER!);
    await page.getByLabel(/^password/i).fill(process.env.LOGIN_PASS!);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL((candidate) => new URL(candidate).pathname === '/', { timeout: 30_000 });
  } else if (page.url() === 'about:blank') {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  }

  await expect(page.locator('[data-app-shell]')).toBeVisible();
  const prefsResponse = await page.request.get(`${baseUrl}/api/prefs`);
  if (prefsResponse.ok()) {
    const prefs = (await prefsResponse.json() as { prefs?: { onboarded_at?: string | null } }).prefs;
    if (!prefs?.onboarded_at) {
      const save = page.waitForResponse((response) =>
        response.url().endsWith('/api/prefs') && response.request().method() === 'PATCH');
      await page.getByRole('button', { name: 'Skip', exact: true }).click();
      const response = await save;
      expect(response.ok(), 'onboarding skip saves the preference').toBe(true);
      expect((await response.json()).prefs?.onboarded_at).toBeTruthy();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-app-shell]')).toBeVisible();
    }
  }
  await expect(page.locator('.onboarding-backdrop')).toHaveCount(0);
}

export interface SeedTaskInput {
  title: string;
  description?: string;
  notes?: string;
  due_at?: string;
  scheduled_for?: string;
  task_time?: string;
  estimated_minutes?: number;
  priority?: number;
  tags?: string[];
}

export interface SeedBlockInput {
  title: string;
  start_at: string;
  end_at: string;
  task_id?: string;
  block_kind?: 'task' | 'timeblock' | 'meeting';
  tag?: string;
  duration_minutes?: number;
  recurrence_rule?: string;
}

interface OwnerResponse {
  ownerId: string;
  name: string;
  username: string | null;
}

interface TaskResponse {
  task: { id: string; title: string; status: string };
}

interface BlockResponse {
  block: { id: string; title: string; start_at: string; end_at: string };
}

interface ObjectiveResponse {
  objective: { id: string; title: string; parent_id: string | null };
}

interface TagResponse {
  tag: { id: string; name: string; kind: 'direction' | 'intention' | 'category' };
}

/**
 * Request-scoped test data for the currently authenticated owner. Every row is
 * created through the same REST APIs as the app, and only IDs created by this
 * fixture are removed during cleanup.
 */
export class OwnerFixtures {
  private readonly taskIds: string[] = [];
  private readonly blockIds: string[] = [];
  private readonly stagedTaskIds: string[] = [];
  private readonly objectiveIds: string[] = [];
  private readonly tagIds: string[] = [];
  private owner?: OwnerResponse;
  private taskNumber = 0;
  private blockNumber = 0;

  constructor(
    private readonly request: APIRequestContext,
    private readonly runId: string,
    private readonly baseUrl = appUrl(),
  ) {}

  async currentOwner(): Promise<OwnerResponse> {
    if (this.owner) return this.owner;
    const response = await this.request.get(`${this.baseUrl}/api/auth/me`);
    if (!response.ok()) throw new Error(`Test data requires an authenticated owner (GET /api/auth/me returned ${response.status()}).`);
    this.owner = await response.json() as OwnerResponse;
    if (!this.owner.ownerId) throw new Error('GET /api/auth/me did not return an ownerId.');
    return this.owner;
  }

  async createTask(input: Partial<SeedTaskInput> = {}): Promise<TaskResponse['task']> {
    await this.currentOwner();
    const number = ++this.taskNumber;
    const response = await this.request.post(`${this.baseUrl}/api/tasks`, {
      data: { ...input, title: input.title ?? `E2E ${this.runId} task ${number}` },
    });
    if (!response.ok()) throw new Error(`Could not seed task (${response.status()}): ${await response.text()}`);
    const task = (await response.json() as TaskResponse).task;
    if (!task?.id) throw new Error('POST /api/tasks did not return a task ID.');
    this.trackTask(task.id);
    return task;
  }

  trackTask(id: string): void {
    if (!this.taskIds.includes(id)) this.taskIds.push(id);
  }

  async createObjective(title: string, parentId: string | null = null): Promise<ObjectiveResponse['objective']> {
    await this.currentOwner();
    const response = await this.request.post(`${this.baseUrl}/api/objectives`, {
      data: { title, parent_id: parentId, status: 'active', horizon: 'none', cadence: 'none' },
    });
    if (!response.ok()) throw new Error(`Could not seed objective (${response.status()}): ${await response.text()}`);
    const objective = (await response.json() as ObjectiveResponse).objective;
    if (!objective?.id) throw new Error('POST /api/objectives did not return an objective ID.');
    this.trackObjective(objective.id);
    return objective;
  }

  trackObjective(id: string): void {
    if (!this.objectiveIds.includes(id)) this.objectiveIds.push(id);
  }

  async createTag(input: {
    name: string;
    kind?: 'direction' | 'intention' | 'category';
    directions?: string[];
    categories?: string[];
  }): Promise<TagResponse['tag']> {
    await this.currentOwner();
    const response = await this.request.post(`${this.baseUrl}/api/tags`, { data: input });
    if (!response.ok()) throw new Error(`Could not seed tag (${response.status()}): ${await response.text()}`);
    const tag = (await response.json() as TagResponse).tag;
    if (!tag?.id) throw new Error('POST /api/tags did not return a tag ID.');
    this.tagIds.push(tag.id);
    return tag;
  }

  async createBlock(input: Partial<SeedBlockInput> & Pick<SeedBlockInput, 'start_at' | 'end_at'>): Promise<BlockResponse['block']> {
    await this.currentOwner();
    const number = ++this.blockNumber;
    const response = await this.request.post(`${this.baseUrl}/api/blocks`, {
      data: {
        ...input,
        title: input.title ?? `E2E ${this.runId} block ${number}`,
        block_kind: input.block_kind ?? 'timeblock',
      },
    });
    if (!response.ok()) throw new Error(`Could not seed time block (${response.status()}): ${await response.text()}`);
    const block = (await response.json() as BlockResponse).block;
    if (!block?.id) throw new Error('POST /api/blocks did not return a block ID.');
    this.blockIds.push(block.id);
    return block;
  }

  async createRecurringBlock(input: Partial<SeedBlockInput> & Pick<SeedBlockInput, 'start_at' | 'end_at'>): Promise<{
    template: BlockResponse['block'];
    occurrences: Array<{ id: string; title: string; recurrence_parent_id: string }>;
  }> {
    const template = await this.createBlock(input);
    const rangeStart = new Date(input.start_at);
    rangeStart.setUTCHours(0, 0, 0, 0);
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 4);
    const query = new URLSearchParams({ from: rangeStart.toISOString(), to: rangeEnd.toISOString() });
    const response = await this.request.get(`${this.baseUrl}/api/blocks?${query}`);
    if (!response.ok()) throw new Error(`Could not list generated Time Block occurrences (${response.status()}).`);
    const rows = (await response.json() as { blocks: Array<{ id: string; title: string; recurrence_parent_id?: string | null }> }).blocks;
    const occurrences = rows.filter((block) => block.recurrence_parent_id === template.id);
    if (occurrences.length === 0) throw new Error(`Recurring Time Block ${template.id} did not generate an occurrence.`);
    occurrences.forEach((block) => this.blockIds.push(block.id));
    return { template, occurrences: occurrences as Array<{ id: string; title: string; recurrence_parent_id: string }> };
  }

  async stageTask(taskId: string): Promise<void> {
    await this.currentOwner();
    const response = await this.request.post(`${this.baseUrl}/api/flight-plan`, { data: { task_id: taskId } });
    if (!response.ok()) throw new Error(`Could not stage seeded task ${taskId} (${response.status()}): ${await response.text()}`);
    this.stagedTaskIds.push(taskId);
  }

  async cleanup(): Promise<void> {
    // Delete placements/containers before tasks so task-backed blocks can revert
    // their task state cleanly and the fixture can never leave a stale placement.
    for (const id of [...this.blockIds].reverse()) {
      const response = await this.request.delete(`${this.baseUrl}/api/blocks/${encodeURIComponent(id)}`);
      if (!response.ok() && response.status() !== 404) {
        throw new Error(`Could not clean up seeded block ${id} (${response.status()}).`);
      }
    }
    for (const id of [...this.stagedTaskIds].reverse()) {
      const response = await this.request.delete(`${this.baseUrl}/api/flight-plan/${encodeURIComponent(id)}`);
      if (!response.ok() && response.status() !== 404) {
        throw new Error(`Could not clean up seeded Flight Plan entry ${id} (${response.status()}).`);
      }
    }
    for (const id of [...this.taskIds].reverse()) {
      const response = await this.request.delete(`${this.baseUrl}/api/tasks/${encodeURIComponent(id)}`);
      if (!response.ok() && response.status() !== 404) {
        throw new Error(`Could not clean up seeded task ${id} (${response.status()}).`);
      }
    }
    for (const id of [...this.objectiveIds].reverse()) {
      const response = await this.request.delete(`${this.baseUrl}/api/objectives/${encodeURIComponent(id)}`);
      if (!response.ok() && response.status() !== 404) {
        throw new Error(`Could not archive seeded objective ${id} (${response.status()}).`);
      }
    }
    for (const id of [...this.tagIds].reverse()) {
      const response = await this.request.delete(`${this.baseUrl}/api/tags/${encodeURIComponent(id)}`);
      if (!response.ok() && response.status() !== 404) {
        throw new Error(`Could not clean up seeded tag ${id} (${response.status()}).`);
      }
    }
  }
}
