/**
 * Live measurement harness for the complexity rubric (ticket llm-9).
 *
 * OPT-IN ONLY — inert unless `LIVE_RUBRIC=1` is set, because it needs a running Ollama
 * and takes minutes. It is committed so the before/after evidence in
 * `docs/complexity-rubric-measurement-2026-08.md` can be reproduced rather than believed.
 *
 * Why it wraps `generateJson` instead of re-typing the prompts: the whole point is to
 * measure the REAL prompt each agent sends. The wrapper calls the real `generate`, keeps
 * the raw string so non-emptiness can be ASSERTED (a `thinking`-capable model answers ""
 * under format:"json", which reads exactly like "unchanged" — see lib/models.ts), and
 * only then parses.
 *
 *   LIVE_RUBRIC=1 LIVE_RUBRIC_OUT=<path.json> pnpm --filter server test rubric-live-measure
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
// Installs the SQLite store; model resolution reads the per-owner Settings override.
import '../src/db/index.js';

const LIVE = process.env.LIVE_RUBRIC === '1';
const RUNS = Number(process.env.LIVE_RUBRIC_RUNS ?? 5);
const OUT = process.env.LIVE_RUBRIC_OUT ?? '';

const { calls } = vi.hoisted(() => ({ calls: [] as { prompt: string; raw: string }[] }));

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return {
    ...real,
    // Same call, but the raw completion is retained before parsing.
    generateJson: async (prompt: string, opts: Record<string, unknown> = {}) => {
      const raw = await real.generate(prompt, { ...opts, json: true });
      calls.push({ prompt, raw });
      return real.parseJsonLoose(raw);
    },
  };
});

const EXPECT_TRUE = [
  'Plan a week-long trip to Japan',
  'Organize the team offsite',
  'Research and launch the new pricing page',
  'Prepare the annual budget review',
  'Move house',
];
const EXPECT_FALSE = ['Call the dentist', 'Pay a bill', 'Pay the electricity bill', 'Send the invoice'];
const CASES = [
  ...EXPECT_TRUE.map((title) => ({ title, expect: true })),
  ...EXPECT_FALSE.map((title) => ({ title, expect: false })),
];

const VOCAB = {
  directions: ['work', 'home', 'community'],
  others: ['email', 'errands'],
  categories: ['health'],
};

interface CaseResult {
  title: string;
  expected: boolean;
  quickadd: (boolean | null)[];
  subtasksVerdict: (boolean | null)[];
  subtasksSteps: number[];
}

const results: CaseResult[] = [];
let fastModel = '';

describe.skipIf(!LIVE)('complexity rubric · live measurement', () => {
  beforeAll(async () => {
    // vitest sets NODE_ENV=test, which stops ollama.status() from filling the installed
    // cache, so do it here: with the cache filled, resolveModel() performs the SAME
    // auto-selection production does (fast → smallest tools-capable non-thinking model).
    const { setInstalledModels, parseParamB, resolveModel } = await import('../src/lib/models.js');
    const res = await fetch(`${process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'}/api/tags`);
    const data = (await res.json()) as {
      models?: { name: string; capabilities?: string[]; details?: { parameter_size?: string } }[];
    };
    const rows = (data.models ?? []).map((m) => ({
      name: m.name,
      capabilities: m.capabilities ?? [],
      paramB: parseParamB(m.details?.parameter_size),
    }));
    setInstalledModels(rows);
    fastModel = await resolveModel('fast');
    // The empty-response trap: assert the selected model is not thinking-capable.
    const picked = rows.find((r) => r.name === fastModel);
    expect(picked, `fast model ${fastModel} is not installed`).toBeTruthy();
    expect(picked!.capabilities).not.toContain('thinking');
    // eslint-disable-next-line no-console
    console.log(`[live] fast tier resolves to ${fastModel} (caps: ${picked!.capabilities.join(',')})`);
  });

  for (const c of CASES) {
    it(
      `${c.title} (expect ${c.expect})`,
      async () => {
        const { enrichQuick } = await import('../src/agents/quickadd.js');
        const { suggestSubtasks } = await import('../src/agents/subtasks.js');
        const row: CaseResult = {
          title: c.title,
          expected: c.expect,
          quickadd: [],
          subtasksVerdict: [],
          subtasksSteps: [],
        };
        for (let i = 0; i < RUNS; i++) {
          // ── quick-add classifier (COMPLEXITY_RUBRIC) ──
          const before = calls.length;
          await enrichQuick(c.title, { title: c.title, tags: [] }, VOCAB);
          const classify = calls[before]; // the first call; a direction retry may follow
          expect(classify, 'no classify call recorded').toBeTruthy();
          expect(classify.raw.trim().length, `empty response for "${c.title}"`).toBeGreaterThan(0);
          const parsedClassify = JSON.parse(classify.raw) as { isComplex?: unknown };
          row.quickadd.push(typeof parsedClassify.isComplex === 'boolean' ? parsedClassify.isComplex : null);

          // ── subtask suggester (the composed isBreakdownUseful prompt) ──
          const beforeSub = calls.length;
          const steps = await suggestSubtasks(c.title);
          const sub = calls[beforeSub];
          expect(sub, 'no subtasks call recorded').toBeTruthy();
          expect(sub.raw.trim().length, `empty response for "${c.title}"`).toBeGreaterThan(0);
          const parsedSub = JSON.parse(sub.raw) as { isBreakdownUseful?: unknown };
          row.subtasksVerdict.push(
            typeof parsedSub.isBreakdownUseful === 'boolean' ? parsedSub.isBreakdownUseful : null,
          );
          row.subtasksSteps.push(steps.length);
        }
        results.push(row);
        // eslint-disable-next-line no-console
        console.log(
          `[live] ${c.title}\n` +
            `        quickadd.isComplex      ${JSON.stringify(row.quickadd)}\n` +
            `        subtasks.isBreakdownUseful ${JSON.stringify(row.subtasksVerdict)}\n` +
            `        subtasks steps returned ${JSON.stringify(row.subtasksSteps)}`,
        );
        if (OUT) writeFileSync(OUT, JSON.stringify({ fastModel, runs: RUNS, results }, null, 2));
      },
      20 * 60_000,
    );
  }
});
