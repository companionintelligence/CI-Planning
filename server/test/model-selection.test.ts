import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { config } from '../src/lib/config.js';
import {
  resolveModel,
  resolveEmbedModel,
  setInstalledModels,
  autoSelectModel,
  autoSelectEmbedModel,
  explainModel,
  explainModelDefault,
  generationSelectionWarnings,
  isInstalled,
  parseParamB,
  type InstalledModel,
} from '../src/lib/models.js';
import { resetDb } from './helpers.js';

/**
 * Auto-selection of a REAL installed model.
 *
 * The bug this pins: the built-in defaults (`qwen2.5:0.5b` / `gemma3n:e4b`) are tags that
 * most machines never pulled, and nothing noticed — `/api/tags` answered, so the app
 * advertised "Ollama available ✓" while every call died with `model '…' not found`.
 *
 * The `thinking` exclusion is not a style preference. Re-measured against Ollama 0.30.10
 * (2026-07-30): 3 of 5 installed thinking models answered `format:"json"` with an EMPTY
 * `response` and their content diverted into the separate `thinking` field — precisely the
 * silent-nothing failure quick-add and plan ordering suffered. It is not predictable from
 * capabilities (`qwen3:8b` works, `qwen3-vl:8b` does not, and they differ only by
 * `vision`), and `think:false` does not rescue it, so the blunt exclusion stays. See the
 * measurement table in src/lib/models.ts.
 *
 * The `tools` preference exists because exclusion alone is not enough: on a box whose only
 * non-thinking models were `moondream:latest` (1B, vision, no tools) and a 30B coder, the
 * smallest-wins rule handed the latency-sensitive fast tier to the vision model.
 */

const OWNER = SYSTEM_OWNER;

/** Mirrors the shapes seen from a real `/api/tags` (incl. an M-suffixed size). */
const LLAMA_32: InstalledModel = { name: 'llama3.2:latest', capabilities: ['completion', 'tools'], paramB: 3.2 };
const LLAMA_31: InstalledModel = { name: 'llama3.1:latest', capabilities: ['completion', 'tools'], paramB: 8.0 };
const QWEN_THINK: InstalledModel = {
  name: 'qwen3.5:0.8b',
  capabilities: ['vision', 'completion', 'tools', 'thinking'],
  paramB: 0.87344,
};
const EMBEDDER: InstalledModel = { name: 'nomic-embed-text:latest', capabilities: ['embedding'], paramB: 0.137 };

/** The real shapes from the box that motivated the `tools` preference (Ollama 0.30.10). */
const MOONDREAM: InstalledModel = { name: 'moondream:latest', capabilities: ['completion', 'vision'], paramB: 1 };
const CODER_30B: InstalledModel = { name: 'qwen3-coder:30b', capabilities: ['completion', 'tools'], paramB: 30.5 };
const QWEN25_7B: InstalledModel = { name: 'qwen2.5:7b', capabilities: ['completion', 'tools'], paramB: 7.6 };

const REALISTIC = [LLAMA_32, LLAMA_31, QWEN_THINK, EMBEDDER];

function setPrefs(fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  sqlite.prepare(`UPDATE scheduling_prefs SET ${set} WHERE owner_id = ?`).run(...keys.map((k) => fields[k]), OWNER);
}

beforeEach(() => {
  resetDb();
  setPrefs({ fast_model: null, quality_model: null, embed_model: null });
  setInstalledModels(null);
});

// The cache is module state shared with every other suite — never leak a probed set.
afterEach(() => setInstalledModels(null));

describe('parseParamB', () => {
  it('normalizes B and M suffixes, and rejects junk', () => {
    expect(parseParamB('3.2B')).toBeCloseTo(3.2);
    expect(parseParamB('27.8B')).toBeCloseTo(27.8);
    expect(parseParamB('873.44M')).toBeCloseTo(0.87344);
    expect(parseParamB(undefined)).toBeNull();
    expect(parseParamB('unknown')).toBeNull();
  });
});

describe('auto-selection', () => {
  it('excludes thinking models — they return "" under format:json', () => {
    setInstalledModels(REALISTIC);
    expect(autoSelectModel('small')).toBe(LLAMA_32.name);
    expect(autoSelectModel('medium')).toBe(LLAMA_31.name);
  });

  it('picks smallest for the fast tier and largest for the quality tier', () => {
    setInstalledModels([LLAMA_31, LLAMA_32]);
    expect(autoSelectModel('small')).toBe(LLAMA_32.name); // 3.2B
    expect(autoSelectModel('medium')).toBe(LLAMA_31.name); // 8.0B
  });

  it('never offers an embedding model for generation, or a generation model for embedding', () => {
    setInstalledModels(REALISTIC);
    expect(autoSelectModel('small')).not.toBe(EMBEDDER.name);
    expect(autoSelectEmbedModel()).toBe(EMBEDDER.name);
  });

  it('returns null when only unusable models are installed, so callers keep the default', () => {
    setInstalledModels([QWEN_THINK]);
    expect(autoSelectModel('small')).toBeNull();
    expect(autoSelectEmbedModel()).toBeNull();
  });

  it('degrades open when the Ollama build reports no capabilities at all', () => {
    // Older Ollama omits `capabilities`; excluding on that would select nothing.
    setInstalledModels([{ name: 'mystery:7b', capabilities: [], paramB: 7 }]);
    expect(autoSelectModel('small')).toBe('mystery:7b');
  });

  it('does not hand the fast tier to a small vision model over a tool-capable one', () => {
    // The reported regression: smallest-wins alone picked moondream (1B, vision, no
    // tools) for the tier that drives tagging and quick-add enrichment.
    setInstalledModels([MOONDREAM, CODER_30B, QWEN25_7B]);
    expect(autoSelectModel('small')).toBe(QWEN25_7B.name);
    expect(autoSelectModel('medium')).toBe(CODER_30B.name);
  });

  it('still uses a no-tools model when it is genuinely the only option', () => {
    // Deprioritized, not banned — a bad model beats no model at all.
    setInstalledModels([MOONDREAM]);
    expect(autoSelectModel('small')).toBe(MOONDREAM.name);
    expect(autoSelectModel('medium')).toBe(MOONDREAM.name);
  });

  it('does not demote a vision model that also advertises tools', () => {
    // `vision` is not the signal — `tools` is. A multimodal instruct model is fine.
    const VISION_TOOLS = { name: 'gemma4:9b', capabilities: ['completion', 'vision', 'tools'], paramB: 9 };
    setInstalledModels([MOONDREAM, VISION_TOOLS]);
    expect(autoSelectModel('small')).toBe(VISION_TOOLS.name); // 9B beats a preferred-band-less 1B
  });

  it('prefers the size rule within the preferred band, not across bands', () => {
    // A 1B no-tools model must not win the small tier just for being smallest.
    setInstalledModels([MOONDREAM, QWEN25_7B, CODER_30B]);
    expect(autoSelectModel('small')).not.toBe(MOONDREAM.name);
  });
});

describe('selection reporting', () => {
  it('reports auto-selection distinctly from a pin, a default and an unknown set', () => {
    setInstalledModels(null);
    expect(explainModelDefault('small').source).toBe('unknown');

    setInstalledModels([{ name: config.ollamaSmallModel, capabilities: ['completion', 'tools'], paramB: 0.5 }]);
    expect(explainModelDefault('small').source).toBe('default');

    setInstalledModels(REALISTIC); // configured default not installed → rescue
    expect(explainModelDefault('small')).toEqual({ name: LLAMA_32.name, source: 'auto' });

    setInstalledModels([QWEN_THINK]); // nothing qualifies
    expect(explainModelDefault('small')).toEqual({ name: config.ollamaSmallModel, source: 'unresolved' });
  });

  it('reports an env pin as a pin, without consulting the installed set', () => {
    setInstalledModels(REALISTIC);
    const pinned = { ...config.ollamaPinned };
    const saved = config.ollamaSmallModel;
    try {
      (config as { ollamaSmallModel: string }).ollamaSmallModel = 'pinned-by-operator:9b';
      config.ollamaPinned.small = true;
      expect(explainModelDefault('small')).toEqual({ name: 'pinned-by-operator:9b', source: 'pin' });
    } finally {
      (config as { ollamaSmallModel: string }).ollamaSmallModel = saved;
      Object.assign(config.ollamaPinned, pinned);
    }
  });

  it('warns when an auto-selected tier fell through to a model with no tool use', () => {
    setInstalledModels([MOONDREAM]);
    const warnings = generationSelectionWarnings([
      { tier: 'small', model: { name: MOONDREAM.name, source: 'auto' } },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('moondream:latest');
    expect(warnings[0]).toContain('tool use');
  });

  it('reports a per-owner Settings choice as an override, distinct from an env pin', async () => {
    setInstalledModels(REALISTIC);
    setPrefs({ fast_model: 'hand-picked:1b' });
    expect(await explainModel('small', OWNER)).toEqual({ name: 'hand-picked:1b', source: 'override' });
  });

  it('stays silent for a deliberate choice, however bad — pins are never second-guessed', () => {
    setInstalledModels([MOONDREAM]);
    for (const source of ['pin', 'override'] as const) {
      expect(
        generationSelectionWarnings([{ tier: 'small', model: { name: MOONDREAM.name, source } }]),
      ).toEqual([]);
    }
  });

  it('stays silent when the auto-selected model is tool-capable', () => {
    setInstalledModels([QWEN25_7B]);
    expect(
      generationSelectionWarnings([{ tier: 'small', model: { name: QWEN25_7B.name, source: 'auto' } }]),
    ).toEqual([]);
  });
});

describe('isInstalled', () => {
  it('matches an untagged name against the :latest tag (Settings and env are hand-typed)', () => {
    setInstalledModels(REALISTIC);
    expect(isInstalled('llama3.2')).toBe(true);
    expect(isInstalled('llama3.2:latest')).toBe(true);
    expect(isInstalled('gemma3n:e4b')).toBe(false);
  });

  it('is false while the installed set is unknown', () => {
    setInstalledModels(null);
    expect(isInstalled('llama3.2')).toBe(false);
  });
});

describe('resolveModel precedence', () => {
  it('falls back to the configured default while the installed set is unknown', async () => {
    // The pre-probe / Ollama-offline path — and what keeps this suite deterministic on
    // machines that do or do not happen to be running Ollama.
    setInstalledModels(null);
    expect(await resolveModel('small', OWNER)).toBe(config.ollamaSmallModel);
    expect(await resolveModel('medium', OWNER)).toBe(config.ollamaMediumModel);
    expect(await resolveEmbedModel(OWNER)).toBe(config.ollamaEmbedModel);
  });

  it('keeps the configured default when it IS installed', async () => {
    setInstalledModels([{ name: config.ollamaSmallModel, capabilities: ['completion'], paramB: 0.5 }, LLAMA_31]);
    expect(await resolveModel('small', OWNER)).toBe(config.ollamaSmallModel);
  });

  it('rescues an uninstalled default with a real installed model (the reported bug)', async () => {
    setInstalledModels(REALISTIC); // neither qwen2.5:0.5b nor gemma3n:e4b present
    expect(await resolveModel('small', OWNER)).toBe(LLAMA_32.name);
    expect(await resolveModel('medium', OWNER)).toBe(LLAMA_31.name);
    // The embed default needs no rescue: the untagged `nomic-embed-text` matches the
    // installed `nomic-embed-text:latest`, so it is kept verbatim (Ollama resolves the
    // tag itself). Only a genuinely absent model is replaced — see the next case.
    expect(await resolveEmbedModel(OWNER)).toBe(config.ollamaEmbedModel);
  });

  it('rescues the embed tier when no matching embedder is installed', async () => {
    setInstalledModels([LLAMA_32, { name: 'mxbai-embed-large:latest', capabilities: ['embedding'], paramB: 0.335 }]);
    expect(await resolveEmbedModel(OWNER)).toBe('mxbai-embed-large:latest');
  });

  it('honors a per-owner Settings override even when it is not installed', async () => {
    // An explicit user choice is never second-guessed; status() surfaces it as missing.
    setInstalledModels(REALISTIC);
    setPrefs({ fast_model: 'hand-picked:1b' });
    expect(await resolveModel('small', OWNER)).toBe('hand-picked:1b');
  });

  it('ignores a blank override', async () => {
    setInstalledModels(REALISTIC);
    setPrefs({ fast_model: '   ' });
    expect(await resolveModel('small', OWNER)).toBe(LLAMA_32.name);
  });

  it('uses an env pin verbatim rather than auto-selecting', async () => {
    setInstalledModels(REALISTIC);
    const pinned = { ...config.ollamaPinned };
    const saved = config.ollamaSmallModel;
    try {
      (config as { ollamaSmallModel: string }).ollamaSmallModel = 'pinned-by-operator:9b';
      config.ollamaPinned.small = true;
      expect(await resolveModel('small', OWNER)).toBe('pinned-by-operator:9b');
    } finally {
      (config as { ollamaSmallModel: string }).ollamaSmallModel = saved;
      Object.assign(config.ollamaPinned, pinned);
    }
  });

  it('keeps the default (so the error names it) when nothing installed qualifies', async () => {
    setInstalledModels([QWEN_THINK]);
    expect(await resolveModel('small', OWNER)).toBe(config.ollamaSmallModel);
  });
});
