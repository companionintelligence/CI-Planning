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
import { notificationsRouter } from './notifications.js';
import { backupRouter } from './backup.js';
import { healthRouter } from './health.js';
import { oauthRouter } from './oauth.js';

export function mountRoutes(app: Koa) {
  for (const router of [
    healthRouter(),
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
    notificationsRouter(),
    backupRouter(),
    oauthRouter(),
  ]) {
    app.use(router.routes()).use(router.allowedMethods());
  }
}
