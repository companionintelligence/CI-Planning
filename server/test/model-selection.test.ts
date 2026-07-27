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
 * The `thinking` exclusion is not a style preference: verified against a live Ollama, a
 * thinking model asked for `format:"json"` returns an EMPTY string, which is precisely the
 * silent-nothing failure quick-add and plan ordering suffered.
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
  it('falls back to the configured default while the installed set is unknown', () => {
    // The pre-probe / Ollama-offline path — and what keeps this suite deterministic on
    // machines that do or do not happen to be running Ollama.
    setInstalledModels(null);
    expect(resolveModel('small', OWNER)).toBe(config.ollamaSmallModel);
    expect(resolveModel('medium', OWNER)).toBe(config.ollamaMediumModel);
    expect(resolveEmbedModel(OWNER)).toBe(config.ollamaEmbedModel);
  });

  it('keeps the configured default when it IS installed', () => {
    setInstalledModels([{ name: config.ollamaSmallModel, capabilities: ['completion'], paramB: 0.5 }, LLAMA_31]);
    expect(resolveModel('small', OWNER)).toBe(config.ollamaSmallModel);
  });

  it('rescues an uninstalled default with a real installed model (the reported bug)', () => {
    setInstalledModels(REALISTIC); // neither qwen2.5:0.5b nor gemma3n:e4b present
    expect(resolveModel('small', OWNER)).toBe(LLAMA_32.name);
    expect(resolveModel('medium', OWNER)).toBe(LLAMA_31.name);
    // The embed default needs no rescue: the untagged `nomic-embed-text` matches the
    // installed `nomic-embed-text:latest`, so it is kept verbatim (Ollama resolves the
    // tag itself). Only a genuinely absent model is replaced — see the next case.
    expect(resolveEmbedModel(OWNER)).toBe(config.ollamaEmbedModel);
  });

  it('rescues the embed tier when no matching embedder is installed', () => {
    setInstalledModels([LLAMA_32, { name: 'mxbai-embed-large:latest', capabilities: ['embedding'], paramB: 0.335 }]);
    expect(resolveEmbedModel(OWNER)).toBe('mxbai-embed-large:latest');
  });

  it('honors a per-owner Settings override even when it is not installed', () => {
    // An explicit user choice is never second-guessed; status() surfaces it as missing.
    setInstalledModels(REALISTIC);
    setPrefs({ fast_model: 'hand-picked:1b' });
    expect(resolveModel('small', OWNER)).toBe('hand-picked:1b');
  });

  it('ignores a blank override', () => {
    setInstalledModels(REALISTIC);
    setPrefs({ fast_model: '   ' });
    expect(resolveModel('small', OWNER)).toBe(LLAMA_32.name);
  });

  it('uses an env pin verbatim rather than auto-selecting', () => {
    setInstalledModels(REALISTIC);
    const pinned = { ...config.ollamaPinned };
    const saved = config.ollamaSmallModel;
    try {
      (config as { ollamaSmallModel: string }).ollamaSmallModel = 'pinned-by-operator:9b';
      config.ollamaPinned.small = true;
      expect(resolveModel('small', OWNER)).toBe('pinned-by-operator:9b');
    } finally {
      (config as { ollamaSmallModel: string }).ollamaSmallModel = saved;
      Object.assign(config.ollamaPinned, pinned);
    }
  });

  it('keeps the default (so the error names it) when nothing installed qualifies', () => {
    setInstalledModels([QWEN_THINK]);
    expect(resolveModel('small', OWNER)).toBe(config.ollamaSmallModel);
  });
});
