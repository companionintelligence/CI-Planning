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
import { dayReflowRouter } from './day-reflow.js';
import { patternPrefsRouter } from './pattern-prefs.js';
import { categoryPrefsRouter } from './category-prefs.js';
import { connectionPrefsRouter } from './connection-prefs.js';
import { notificationsRouter } from './notifications.js';
import { backupRouter } from './backup.js';
import { healthRouter } from './health.js';
import { telemetryConfigRouter } from './telemetry-config.js';
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
import { metricsRouter } from './metrics.js';
import { googleConfigRouter } from './google-config.js';
import { accountsRouter } from './accounts.js';
import { peopleRouter } from './people.js';
import { prioritiesRouter } from './priorities.js';
import { planWeekRouter } from './plan-week.js';
import { connectionsRouter } from './connections.js';
import { trialityRouter } from './triality.js';
import { classificationRouter } from './classification.js';
import { placementRouter } from './placement.js';
import { demoRouter } from './demo.js';

export function mountRoutes(app: Koa) {
  for (const router of [
    healthRouter(),
    telemetryConfigRouter(),
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
    dayReflowRouter(),
    patternPrefsRouter(),
    categoryPrefsRouter(),
    connectionPrefsRouter(),
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
    metricsRouter(),
    googleConfigRouter(),
    accountsRouter(),
    peopleRouter(),
    prioritiesRouter(),
    planWeekRouter(),
    connectionsRouter(),
    trialityRouter(),
    classificationRouter(),
    placementRouter(),
    demoRouter(),
  ]) {
    app.use(router.routes()).use(router.allowedMethods());
  }
}
