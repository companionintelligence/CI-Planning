import { store } from '../db/store.js';

export interface TimeBlockDurationBounds {
  minMinutes: number;
  maxMinutes: number;
  defaultMinutes: number;
}

export interface TimeBlockDurationEvidence {
  minutes: number;
  samples: number;
  basis: 'same title' | 'matching tags';
}

export type TimeBlockDurationSource = 'title_history' | 'tag_history' | 'quick_estimate' | 'default';

export interface TimeBlockDurationSuggestion extends TimeBlockDurationBounds {
  minutes: number;
  source: TimeBlockDurationSource;
  samples: number;
  basis?: TimeBlockDurationEvidence['basis'];
}

const intInRange = (value: number | null | undefined, fallback: number, min: number, max: number) => {
  const n = Number.isFinite(value) ? Math.round(value!) : fallback;
  return Math.max(min, Math.min(max, n));
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Load the owner's scheduled-block range, repairing stale/inverted values in memory. */
export async function timeBlockDurationBounds(owner: string): Promise<TimeBlockDurationBounds> {
  const row = await store().prepare(
    `SELECT min_time_block_minutes, max_time_block_minutes, default_time_block_minutes
       FROM scheduling_prefs WHERE owner_id = ?`,
  ).get<{ min_time_block_minutes: number | null; max_time_block_minutes: number | null; default_time_block_minutes: number | null }>(owner);

  const minMinutes = intInRange(row?.min_time_block_minutes, 15, 5, 1440);
  const maxMinutes = Math.max(minMinutes, intInRange(row?.max_time_block_minutes, 240, 5, 1440));
  const defaultMinutes = intInRange(row?.default_time_block_minutes, 60, minMinutes, maxMinutes);
  return { minMinutes, maxMinutes, defaultMinutes };
}

/**
 * Look for duration evidence owned by this user. Measured task time wins over
 * completed Plan durations; repeated completed tasks in one of the supplied tags
 * provide a broader fallback when this exact title has never been done.
 */
export async function findTimeBlockDurationEvidence(
  owner: string,
  title: string,
  tagNames: string[],
): Promise<TimeBlockDurationEvidence | null> {
  const normalizedTitle = title.trim().replace(/\s+/g, ' ');
  if (!normalizedTitle) return null;

  const taskRows = await store().prepare(
    `SELECT actual_minutes
       FROM tasks
      WHERE owner_id = ? AND status = 'done' AND actual_minutes > 0
        AND LOWER(TRIM(title)) = LOWER(TRIM(?))
      ORDER BY completed_at DESC LIMIT 20`,
  ).all<{ actual_minutes: number }>(owner, normalizedTitle);
  if (taskRows.length) {
    return { minutes: median(taskRows.map((r) => r.actual_minutes)), samples: taskRows.length, basis: 'same title' };
  }

  const completedBlocks = await store().prepare(
    `SELECT start_at, end_at
       FROM time_blocks
      WHERE owner_id = ? AND block_kind = 'timeblock' AND status = 'completed'
        AND LOWER(TRIM(title)) = LOWER(TRIM(?))
      ORDER BY created_at DESC LIMIT 20`,
  ).all<{ start_at: string; end_at: string }>(owner, normalizedTitle);
  const blockDurations = completedBlocks
    .map((r) => Math.round((Date.parse(r.end_at) - Date.parse(r.start_at)) / 60_000))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (blockDurations.length) {
    return { minutes: median(blockDurations), samples: blockDurations.length, basis: 'same title' };
  }

  const tags = [...new Set(tagNames.map((n) => n.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  if (!tags.length) return null;

  const tagRows = await store().prepare(
    `SELECT DISTINCT t.id, t.actual_minutes, t.completed_at
       FROM tasks t
       JOIN entity_tags et ON et.entity_id = t.id AND et.entity_kind = 'task'
       JOIN tags g ON g.id = et.tag_id AND g.owner_id = t.owner_id
      WHERE t.owner_id = ? AND t.status = 'done' AND t.actual_minutes > 0
        AND LOWER(g.name) IN (${tags.map(() => '?').join(', ')})
      ORDER BY t.completed_at DESC LIMIT 100`,
  ).all<{ id: string; actual_minutes: number; completed_at: string | null }>(owner, ...tags);

  // Broad tag cohorts can be noisy; require several measured completions before
  // treating their median as stronger evidence than a title-based model estimate.
  if (tagRows.length >= 5) {
    return { minutes: median(tagRows.map((r) => r.actual_minutes)), samples: tagRows.length, basis: 'matching tags' };
  }
  return null;
}

function clampToRange(value: number, bounds: TimeBlockDurationBounds): number {
  const rounded = Math.round(value / 5) * 5;
  return Math.max(bounds.minMinutes, Math.min(bounds.maxMinutes, rounded));
}

/** Prior evidence wins; otherwise use the fast model proposal, then the saved default. */
export function suggestTimeBlockDuration(
  bounds: TimeBlockDurationBounds,
  evidence: TimeBlockDurationEvidence | null,
  quickEstimate: number | null | undefined,
): TimeBlockDurationSuggestion {
  if (evidence) {
    return {
      ...bounds,
      minutes: clampToRange(evidence.minutes, bounds),
      source: evidence.basis === 'same title' ? 'title_history' : 'tag_history',
      samples: evidence.samples,
      basis: evidence.basis,
    };
  }
  if (typeof quickEstimate === 'number' && Number.isFinite(quickEstimate) && quickEstimate > 0) {
    return { ...bounds, minutes: clampToRange(quickEstimate, bounds), source: 'quick_estimate', samples: 0 };
  }
  return { ...bounds, minutes: clampToRange(bounds.defaultMinutes, bounds), source: 'default', samples: 0 };
}
