/**
 * Resolve which Ollama model to use for a given tier, honoring the per-owner
 * override picked in Settings (scheduling_prefs.fast_model / quality_model /
 * embed_model) and falling back to the env defaults (config.ollama*Model) when a
 * column is null. Read at call time so a Settings change takes effect immediately.
 */
import { sqlite } from '../db/index.js';
import { currentOwnerId } from './context.js';
import { config } from './config.js';

interface ModelPrefs {
  fast_model: string | null;
  quality_model: string | null;
  embed_model: string | null;
}

function modelPrefs(owner: string): ModelPrefs | undefined {
  return sqlite
    .prepare(`SELECT fast_model, quality_model, embed_model FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as ModelPrefs | undefined;
}

/** Model for a tier: per-owner override if set (non-blank), else the env default. */
export function resolveModel(tier: 'small' | 'medium', owner: string = currentOwnerId()): string {
  const p = modelPrefs(owner);
  const override = (tier === 'medium' ? p?.quality_model : p?.fast_model)?.trim();
  return override || (tier === 'medium' ? config.ollamaMediumModel : config.ollamaSmallModel);
}

/** Embedding model: per-owner override if set (non-blank), else the env default. */
export function resolveEmbedModel(owner: string = currentOwnerId()): string {
  return modelPrefs(owner)?.embed_model?.trim() || config.ollamaEmbedModel;
}
