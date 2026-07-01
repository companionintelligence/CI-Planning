import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { computeStars } from '../engine/stars.js';
import { isValidISODate } from '../lib/dates.js';

/** All local dates in [from, to] inclusive (noon-UTC pivot → DST-safe). */
function datesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  // Guard against a reversed range or a runaway loop (cap at ~2 years).
  for (let i = 0; i < 800 && cur <= to; i++) {
    out.push(cur);
    const d = new Date(cur + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

export function starsRouter() {
  const router = new Router();

  // GET /api/stars?from=YYYY-MM-DD&to=YYYY-MM-DD
  // For each date in range: the frozen day_stars row if present, else live
  // computeStars. One range query backs a whole calendar month.
  router.get('/api/stars', (ctx) => {
    const owner = currentOwnerId();
    const from = ctx.query.from as string | undefined;
    const to = ctx.query.to as string | undefined;
    if (!isValidISODate(from) || !isValidISODate(to)) {
      ctx.status = 422;
      ctx.body = { error: 'from and to are required (YYYY-MM-DD)' };
      return;
    }

    const frozenRows = sqlite
      .prepare(
        `SELECT date, star_objective, star_habits, star_tasks, star_bonus, star_note, total
           FROM day_stars
          WHERE owner_id = ? AND date >= ? AND date <= ?`,
      )
      .all(owner, from, to) as {
        date: string; star_objective: number; star_habits: number; star_tasks: number;
        star_bonus: number; star_note: number; total: number;
      }[];
    const frozen = new Map(frozenRows.map((r) => [r.date, r]));

    ctx.body = datesInRange(from, to).map((date) => {
      const f = frozen.get(date);
      if (f) {
        return {
          date,
          objective: !!f.star_objective,
          habits: !!f.star_habits,
          tasks: !!f.star_tasks,
          bonus: !!f.star_bonus,
          note: !!f.star_note,
          total: f.total,
          frozen: true,
        };
      }
      const s = computeStars(owner, date);
      return { date, ...s, frozen: false };
    });
  });

  return router;
}
