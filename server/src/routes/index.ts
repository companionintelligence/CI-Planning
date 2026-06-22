import type Koa from 'koa';
import { tasksRouter } from './tasks.js';
import { blocksRouter } from './blocks.js';
import { blockTemplatesRouter } from './block-templates.js';
import { possiblesRouter } from './possibles.js';
import { tagsRouter } from './tags.js';
import { jobsRouter } from './jobs.js';
import { prefsRouter } from './prefs.js';
import { scheduleRouter } from './schedule.js';
import { summaryRouter } from './summary.js';
import { llmRouter } from './llm.js';
import { memoryRouter } from './memory.js';
import { patternsRouter } from './patterns.js';
import { flightPlanRouter } from './flight-plan.js';
import { sseRouter } from './sse.js';
import { patternBlocksRouter } from './pattern-blocks.js';
import { patternPrefsRouter } from './pattern-prefs.js';

export function mountRoutes(app: Koa) {
  for (const router of [
    sseRouter(),
    tasksRouter(),
    blocksRouter(),
    blockTemplatesRouter(),
    possiblesRouter(),
    tagsRouter(),
    jobsRouter(),
    prefsRouter(),
    scheduleRouter(),
    summaryRouter(),
    llmRouter(),
    memoryRouter(),
    patternsRouter(),
    flightPlanRouter(),
    patternBlocksRouter(),
    patternPrefsRouter(),
  ]) {
    app.use(router.routes()).use(router.allowedMethods());
  }
}
