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
import { dayTypesRouter } from './day-types.js';
import { patternPrefsRouter } from './pattern-prefs.js';
import { categoryPrefsRouter } from './category-prefs.js';
import { notificationsRouter } from './notifications.js';
import { backupRouter } from './backup.js';
import { healthRouter } from './health.js';
import { authRouter } from './auth.js';
import { ownerRouter } from './owner.js';
import { oauthRouter } from './oauth.js';
import { planRouter } from './plan.js';
import { syncRouter } from './sync.js';
import { reflectionsRouter } from './reflections.js';
import { objectivesRouter } from './objectives.js';
import { reviewRouter } from './review.js';
import { starsRouter } from './stars.js';
import { plannerRouter } from './planner.js';
import { calibrationRouter } from './calibration.js';
import { googleConfigRouter } from './google-config.js';

export function mountRoutes(app: Koa) {
  for (const router of [
    healthRouter(),
    authRouter(),
    ownerRouter(),
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
    dayTypesRouter(),
    patternPrefsRouter(),
    categoryPrefsRouter(),
    notificationsRouter(),
    backupRouter(),
    oauthRouter(),
    planRouter(),
    syncRouter(),
    reflectionsRouter(),
    objectivesRouter(),
    reviewRouter(),
    starsRouter(),
    plannerRouter(),
    calibrationRouter(),
    googleConfigRouter(),
  ]) {
    app.use(router.routes()).use(router.allowedMethods());
  }
}
