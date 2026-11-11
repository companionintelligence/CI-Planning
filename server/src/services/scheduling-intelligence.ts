import { store } from '../db/store.js';
import { localDateInTZ, serverTimezone, utcToZonedWallTime, todayInTZ } from '../lib/tz.js';
import { resolveDayType } from './day-types.js';

const HISTORY_DAYS = 180;
const PRIOR_STRENGTH = 2;
const EVIDENCE_STRENGTH = 4;
const MAX_HISTORY = 1200;
const MAX_SUGGESTIONS = 8;

/**
 * Outcome evidence is deliberately explainable: a done task with a 4–5 close score is
 * positive, a lower score or a recap miss/deferral is negative, and an unrated done task
 * contributes half weight. The posterior shrinks sparse action/time matches toward the
 * owner's overall outcome rate instead of treating one example as a firm preference.
 */

export const TIME_BANDS = [
  { key: 'early_morning', label: 'Early morning', start: 5, end: 8 },
  { key: 'morning', label: 'Morning', start: 8, end: 12 },
  { key: 'midday', label: 'Midday', start: 12, end: 15 },
  { key: 'afternoon', label: 'Afternoon', start: 15, end: 18 },
  { key: 'evening', label: 'Evening', start: 18, end: 22 },
  { key: 'night', label: 'Night', start: 22, end: 29 },
] as const;

export interface TaskSignals {
  id?: string;
  title: string;
  tags?: string[];
  categories?: string[];
  direction?: string | null;
  motivation?: string | null;
}

interface HistoryRow {
  id: string;
  title: string;
  status: string;
  completion_score: number | null;
  completed_at: string | null;
  recap_date: string | null;
  recap_outcome: string | null;
  placed_at: string | null;
  motivation: string | null;
  event_at: string;
}

interface Features extends TaskSignals {
  action: string | null;
  tagSet: Set<string>;
  categorySet: Set<string>;
  directionSet: Set<string>;
}

interface Observation {
  features: Features;
  good: number;
  weight: number;
  hour: number | null;
  timeBand: string | null;
  dayType: string | null;
}

interface Model {
  timezone: string;
  observations: Observation[];
  globalGood: number;
  featuresFor: (task: TaskSignals) => Features;
  predict: (task: TaskSignals, hour: number, dayType: string) => { probability: number; evidence: number; timeEvidence: number };
  summaries: () => ActionPreference[];
  timeSummaries: () => TimePreference[];
}

export interface ActionPreference {
  action: string;
  good_probability: number;
  samples: number;
  confidence: number;
  preferred_time_band: string | null;
  time_samples: number;
  preferred_window_type: string | null;
}

export interface TimePreference {
  band: string;
  good_probability: number;
  samples: number;
  confidence: number;
}

export interface SchedulingSuggestion {
  task_id: string;
  title: string;
  priority: number;
  estimated_minutes: number | null;
  due_at: string | null;
  action: string | null;
  probability_good: number;
  confidence: number;
  samples: number;
  preferred_time_band: string | null;
  reason: string;
}

export interface SchedulingPreferenceSnapshot {
  history_days: number;
  history_samples: number;
  action_preferences: ActionPreference[];
  time_preferences: TimePreference[];
  suggestions: SchedulingSuggestion[];
}

const ACTION_RULES: Array<[string, RegExp]> = [
  ['Email', /\b(email|e-mail|inbox|reply|respond|newsletter)\b/i],
  ['Calls', /\b(call|phone|voicemail|facetime|zoom)\b/i],
  ['Meetings', /\b(meeting|1:1|one[- ]on[- ]one|check[- ]in|standup)\b/i],
  ['Planning', /\b(plan|planning|schedule|organize|prioritize|calendar)\b/i],
  ['Writing', /\b(write|writing|draft|document|compose|edit|essay|proposal)\b/i],
  ['Review', /\b(review|check|audit|approve|proofread|inspect)\b/i],
  ['Research', /\b(research|read|study|learn|investigate|explore)\b/i],
  ['Exercise', /\b(workout|exercise|gym|run|running|walk|yoga|train)\b/i],
  ['Errands', /\b(errand|shop|buy|pickup|pick up|return|post office|groceries)\b/i],
  ['Home tasks', /\b(clean|laundry|dishes|cook|meal prep|house|repair|maintenance)\b/i],
];

function clean(value: string): string {
  return value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ');
}

function actionFor(task: TaskSignals): string | null {
  const text = `${task.title} ${(task.tags ?? []).join(' ')} ${(task.categories ?? []).join(' ')}`;
  return ACTION_RULES.find(([, re]) => re.test(text))?.[0] ?? null;
}

function makeFeatures(task: TaskSignals): Features {
  const tags = (task.tags ?? []).map(clean).filter(Boolean);
  const categories = (task.categories ?? []).map(clean).filter(Boolean);
  const directions = [task.direction, ...(task.tags ?? []).filter((t) => /^(work|home|community)$/i.test(t))]
    .filter((v): v is string => !!v).map(clean);
  return {
    ...task,
    action: actionFor(task),
    tagSet: new Set(tags),
    categorySet: new Set(categories),
    directionSet: new Set(directions),
  };
}

function bandFor(hour: number): string {
  const normalized = hour < 5 ? hour + 24 : hour;
  return TIME_BANDS.find((b) => normalized >= b.start && normalized < b.end)?.key ?? 'night';
}

function successValue(row: HistoryRow): { good: number; weight: number } | null {
  const outcome = row.recap_outcome;
  const done = row.status === 'done' || outcome === 'completed';
  const failed = ['cancelled', 'missed', 'skipped', 'deferred'].includes(row.status) || ['missed', 'deferred'].includes(outcome ?? '');
  if (!done && !failed) return null;
  if (failed) return { good: 0, weight: 1 };
  // A completed task with a 4–5 close score is a positive outcome; a 1–3 is not.
  // A completion without a rating remains useful but contributes only half a sample.
  if (row.completion_score != null && row.completion_score >= 1 && row.completion_score <= 5) {
    return { good: row.completion_score >= 4 ? 1 : 0, weight: 1 };
  }
  return { good: 1, weight: 0.5 };
}

function evidenceWeight(target: Features, observation: Observation, timeBand?: string, dayType?: string): number {
  const past = observation.features;
  let weight = 0;
  if (target.action && past.action === target.action) weight += 2;
  let sharedTags = 0;
  for (const tag of target.tagSet) if (past.tagSet.has(tag)) sharedTags++;
  weight += Math.min(sharedTags * 0.45, 1.35);
  let sharedCategories = 0;
  for (const category of target.categorySet) if (past.categorySet.has(category)) sharedCategories++;
  weight += Math.min(sharedCategories * 0.8, 1.6);
  for (const direction of target.directionSet) if (past.directionSet.has(direction)) { weight += 0.75; break; }
  if (target.motivation && past.motivation === target.motivation) weight += 0.35;
  if (timeBand && observation.timeBand === timeBand) weight += 1.25;
  if (dayType && observation.dayType === dayType) weight += 0.5;
  return weight * observation.weight;
}

async function dayTypesForDates(owner: string, dates: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!dates.length) return out;
  const marks = dates.map(() => '?').join(',');
  const overrides = await store().prepare(
    `SELECT date, day_type_key FROM day_assignments WHERE owner_id = ? AND date IN (${marks})`,
  ).all<{ date: string; day_type_key: string }>(owner, ...dates);
  for (const row of overrides) out.set(row.date, row.day_type_key);
  const weekly = await store().prepare(
    `SELECT dow, day_type_key FROM day_of_week_map WHERE owner_id = ?`,
  ).all<{ dow: number; day_type_key: string }>(owner);
  const byDow = new Map(weekly.map((r) => [r.dow, r.day_type_key]));
  for (const date of dates) {
    if (out.has(date)) continue;
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    out.set(date, byDow.get(dow) ?? (dow === 0 || dow === 6 ? 'weekend' : 'workday'));
  }
  return out;
}

async function loadTaskLabels(owner: string, ids: string[]): Promise<Map<string, { tags: string[]; categories: string[] }>> {
  const out = new Map<string, { tags: string[]; categories: string[] }>();
  for (const id of ids) out.set(id, { tags: [], categories: [] });
  if (!ids.length) return out;
  // Batch in bounded chunks to stay below SQLite's bind-variable limit.
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    const q = batch.map(() => '?').join(',');
    const tagRows = await store().prepare(
      `SELECT et.entity_id AS id, t.name, t.kind FROM entity_tags et JOIN tags t ON t.id = et.tag_id
        WHERE et.entity_kind = 'task' AND et.entity_id IN (${q}) AND t.owner_id = ?`,
    ).all<{ id: string; name: string; kind: string }>(...batch, owner);
    for (const r of tagRows) out.get(r.id)?.tags.push(r.name);
    const catRows = await store().prepare(
      `SELECT ec.entity_id AS id, t.name FROM entity_categories ec JOIN tags t ON t.id = ec.category_tag_id
        WHERE ec.entity_kind = 'task' AND ec.entity_id IN (${q}) AND t.owner_id = ?`,
    ).all<{ id: string; name: string }>(...batch, owner);
    for (const r of catRows) out.get(r.id)?.categories.push(r.name);
  }
  return out;
}

export async function loadSchedulingIntelligence(owner: string): Promise<Model> {
  const pref = await store().prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get<{ timezone: string | null }>(owner);
  const timezone = pref?.timezone || serverTimezone();
  const since = localDateInTZ(new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString(), timezone);
  const rows = await store().prepare(
    `SELECT * FROM (
       SELECT t.id, t.title, t.status, t.completion_score, t.completed_at,
              NULL AS recap_date, NULL AS recap_outcome,
              (SELECT tb.start_at FROM time_blocks tb WHERE tb.owner_id = t.owner_id AND tb.task_id = t.id
                AND tb.block_kind = 'task' AND tb.start_at >= ? ORDER BY tb.start_at DESC, tb.id DESC LIMIT 1) AS placed_at,
              t.motivation, COALESCE(t.completed_at, t.updated_at, t.created_at) AS event_at
         FROM tasks t
        WHERE t.owner_id = ? AND t.status = 'done' AND t.completed_at IS NOT NULL AND date(t.completed_at) >= ?
       UNION ALL
       SELECT t.id, t.title, t.status, t.completion_score, t.completed_at,
              dp.date AS recap_date, dp.outcome AS recap_outcome,
              COALESCE((SELECT tb.start_at FROM time_blocks tb WHERE tb.id = dp.block_id AND tb.owner_id = t.owner_id),
                       (SELECT tb.start_at FROM time_blocks tb WHERE tb.owner_id = t.owner_id AND tb.task_id = t.id
                         AND tb.block_kind = 'task' AND date(tb.start_at) = dp.date ORDER BY tb.start_at DESC LIMIT 1)) AS placed_at,
              t.motivation, dp.date AS event_at
         FROM daily_plan dp JOIN tasks t ON t.id = dp.task_id AND t.owner_id = dp.owner_id
        WHERE dp.owner_id = ? AND dp.date >= ? AND dp.outcome IN ('deferred', 'missed')
       UNION ALL
       SELECT t.id, t.title, t.status, t.completion_score, t.completed_at,
              NULL AS recap_date, NULL AS recap_outcome,
              (SELECT tb.start_at FROM time_blocks tb WHERE tb.owner_id = t.owner_id AND tb.task_id = t.id
                AND tb.block_kind = 'task' ORDER BY tb.start_at DESC, tb.id DESC LIMIT 1) AS placed_at,
              t.motivation, COALESCE(t.updated_at, t.created_at) AS event_at
         FROM tasks t
        WHERE t.owner_id = ? AND t.status IN ('cancelled', 'missed', 'skipped')
          AND date(COALESCE(t.updated_at, t.created_at)) >= ?
          AND NOT EXISTS (SELECT 1 FROM daily_plan dp WHERE dp.owner_id = t.owner_id AND dp.task_id = t.id
                           AND dp.date >= ? AND dp.outcome IN ('deferred', 'missed'))
     ) history
     ORDER BY event_at DESC, id
     LIMIT ?`,
  ).all<HistoryRow>(`${since}T00:00:00`, owner, since, owner, since, owner, since, since, MAX_HISTORY);

  const labels = await loadTaskLabels(owner, [...new Set(rows.map((r) => r.id))]);
  const dateFor = (row: HistoryRow): string | null => row.placed_at
    ? localDateInTZ(row.placed_at, timezone)
    : row.recap_date ?? (row.completed_at ? localDateInTZ(row.completed_at, timezone) : null);
  const dateByObservation = rows.map(dateFor);
  const dayTypeCache = await dayTypesForDates(owner, [...new Set(dateByObservation.filter((d): d is string => !!d))]);
  const observations: Observation[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const signal = successValue(row);
    if (!signal) continue;
    const names = labels.get(row.id) ?? { tags: [], categories: [] };
    const features = makeFeatures({ id: row.id, title: row.title, tags: names.tags, categories: names.categories, motivation: row.motivation });
    const placedAt = row.placed_at;
    const hour = placedAt ? (() => {
      const wall = utcToZonedWallTime(placedAt, timezone);
      return Number(wall.slice(0, 2)) + Number(wall.slice(3, 5)) / 60;
    })() : null;
    const date = dateByObservation[i] ?? null;
    const dayType = date ? dayTypeCache.get(date) ?? null : null;
    observations.push({
      features,
      good: signal.good,
      weight: signal.weight,
      hour,
      timeBand: hour == null ? null : bandFor(hour),
      dayType,
    });
  }
  const goodWeight = observations.reduce((s, o) => s + o.good * o.weight, 0);
  const sampleWeight = observations.reduce((s, o) => s + o.weight, 0);
  const globalGood = (PRIOR_STRENGTH * 0.5 + goodWeight) / (PRIOR_STRENGTH + sampleWeight);

  const predict = (task: TaskSignals, hour: number, dayType: string) => {
    const target = makeFeatures(task);
    const targetBand = bandFor(hour);
    let evidence = 0;
    let weightedGood = 0;
    let timeEvidence = 0;
    for (const observation of observations) {
      const w = evidenceWeight(target, observation, targetBand, dayType);
      evidence += w;
      weightedGood += w * observation.good;
      if (observation.timeBand === targetBand) timeEvidence += w;
    }
    const probability = (PRIOR_STRENGTH * globalGood + weightedGood) / (PRIOR_STRENGTH + evidence);
    return { probability, evidence, timeEvidence };
  };

  const summaries = (): ActionPreference[] => {
    const actions = [...new Set(observations.map((o) => o.features.action).filter((a): a is string => !!a))];
    return actions.map((action) => {
      const matching = observations.filter((o) => o.features.action === action);
      const weighted = matching.reduce((s, o) => s + o.weight, 0);
      const good = matching.reduce((s, o) => s + o.good * o.weight, 0);
      const bands = TIME_BANDS.map((band) => {
        const samples = matching.filter((o) => o.timeBand === band.key);
        const n = samples.reduce((s, o) => s + o.weight, 0);
        const y = samples.reduce((s, o) => s + o.good * o.weight, 0);
        return { key: band.key, label: band.label, samples: n, probability: (PRIOR_STRENGTH * ((1 + good) / (2 + weighted)) + y) / (PRIOR_STRENGTH + n) };
      }).sort((a, b) => b.probability - a.probability || b.samples - a.samples);
      const dayTypes = new Map<string, number>();
      for (const o of matching) if (o.dayType) dayTypes.set(o.dayType, (dayTypes.get(o.dayType) ?? 0) + o.weight);
      const preferredWindow = [...dayTypes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      const preferredBand = bands.find((b) => b.samples > 0);
      return {
        action,
        good_probability: Math.round(((1 + good) / (2 + weighted)) * 100),
        samples: matching.length,
        confidence: Math.round((weighted / (weighted + EVIDENCE_STRENGTH)) * 100),
        preferred_time_band: preferredBand?.label ?? null,
        time_samples: preferredBand ? Math.round(preferredBand.samples) : 0,
        preferred_window_type: preferredWindow?.[0] ?? null,
      };
    }).sort((a, b) => b.samples - a.samples || a.action.localeCompare(b.action)).slice(0, 8);
  };

  const timeSummaries = (): TimePreference[] => TIME_BANDS.map((band) => {
    const matching = observations.filter((o) => o.timeBand === band.key);
    const n = matching.reduce((s, o) => s + o.weight, 0);
    const y = matching.reduce((s, o) => s + o.good * o.weight, 0);
    return {
      band: band.label,
      good_probability: Math.round(((PRIOR_STRENGTH * globalGood + y) / (PRIOR_STRENGTH + n)) * 100),
      samples: matching.length,
      confidence: Math.round((n / (n + EVIDENCE_STRENGTH)) * 100),
    };
  }).sort((a, b) => b.good_probability - a.good_probability || b.samples - a.samples);

  return { timezone, observations, globalGood, featuresFor: makeFeatures, predict, summaries, timeSummaries };
}

export async function schedulingPreferenceSnapshot(owner: string, date?: string): Promise<SchedulingPreferenceSnapshot> {
  const model = await loadSchedulingIntelligence(owner);
  const targetDate = date ?? todayInTZ(model.timezone);
  const open = await store().prepare(
    `SELECT t.id, t.title, t.priority, t.estimated_minutes, t.due_at, t.motivation
       FROM tasks t
      WHERE t.owner_id = ? AND t.status = 'open' AND t.subtype IS NOT 'habit'
        AND t.parent_id IS NULL AND t.recurrence_parent_id IS NULL
        AND (t.scheduled_for IS NULL OR t.scheduled_for = ?)
        AND t.id NOT IN (SELECT task_id FROM flight_plan WHERE owner_id = ?)
        AND NOT EXISTS (SELECT 1 FROM time_blocks tb WHERE tb.task_id = t.id AND tb.owner_id = t.owner_id
                         AND tb.block_kind = 'task' AND tb.status NOT IN ('completed','skipped','cancelled'))
      ORDER BY t.priority, COALESCE(t.due_at, '9999-12-31'), t.id LIMIT 100`,
  ).all<{ id: string; title: string; priority: number | null; estimated_minutes: number | null; due_at: string | null; motivation: string | null }>(owner, targetDate, owner);
  const labels = await loadTaskLabels(owner, open.map((r) => r.id));
  const dayType = await resolveDayType(owner, targetDate);
  const now = new Date();
  const suggestions: SchedulingSuggestion[] = open.map((task) => {
    const names = labels.get(task.id) ?? { tags: [], categories: [] };
    const signals = { id: task.id, title: task.title, tags: names.tags, categories: names.categories, motivation: task.motivation };
    const features = model.featuresFor(signals);
    const candidates = TIME_BANDS.map((band) => {
      const middle = band.key === 'night' ? 23 : (band.start + band.end) / 2;
      const predicted = model.predict(signals, middle, dayType);
      return { band, ...predicted };
    }).sort((a, b) => b.probability - a.probability || b.evidence - a.evidence);
    const best = candidates.find((c) => c.timeEvidence > 0) ?? null;
    const pGood = best?.probability ?? (candidates.reduce((sum, c) => sum + c.probability, 0) / Math.max(1, candidates.length));
    const priority = Math.min(5, Math.max(1, task.priority ?? 3));
    const priorityWeight = (6 - priority) / 5;
    const dueMs = task.due_at ? Date.parse(task.due_at) : Number.NaN;
    const dueSoon = Number.isFinite(dueMs) ? Math.max(0, Math.min(1, 1 - (dueMs - now.getTime()) / (7 * 86_400_000))) : 0;
    const rank = pGood * (0.75 + 0.25 * priorityWeight) * (1 + 0.2 * dueSoon);
    const evidence = Math.max(...candidates.map((c) => c.evidence), 0);
    const confidence = Math.round((evidence / (evidence + EVIDENCE_STRENGTH)) * 100);
    const reason = best
      ? `Best fit: ${best.band.label.toLowerCase()} · ${Math.round(pGood * 100)}% good-fit estimate`
      : evidence > 0
        ? `Similar-task history · ${Math.round(pGood * 100)}% good-fit estimate · priority P${priority}`
        : `Priority P${priority} · still learning this kind of task`;
    return {
      task_id: task.id,
      title: task.title,
      priority,
      estimated_minutes: task.estimated_minutes,
      due_at: task.due_at,
      action: features.action,
      probability_good: Math.round(pGood * 100),
      confidence,
      samples: Math.round(best?.timeEvidence ?? evidence),
      preferred_time_band: best?.band.label ?? null,
      reason,
      rank,
    } as SchedulingSuggestion & { rank: number };
  }).sort((a, b) => (b as SchedulingSuggestion & { rank: number }).rank - (a as SchedulingSuggestion & { rank: number }).rank || a.priority - b.priority || a.task_id.localeCompare(b.task_id))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ rank: _rank, ...s }) => s);

  return {
    history_days: HISTORY_DAYS,
    history_samples: model.observations.length,
    action_preferences: model.summaries(),
    time_preferences: model.timeSummaries(),
    suggestions,
  };
}
