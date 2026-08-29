import Router from '@koa/router';
import { eq, and, like, asc, lte, ne } from 'drizzle-orm';
import { logger } from '../lib/logger.js';
import { db } from '../db/index.js';
import { store } from '../db/store.js';
import { tasks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { taskToApi } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { getDependencies, blockedTaskIds } from '../engine/deps.js';
import { parseQuick } from '../engine/quickadd.js';
import { enrichQuick } from '../agents/quickadd.js';
import { isMotivation } from '../agents/rubric.js';
import { suggestTags } from '../agents/tags.js';
import { tagUntaggedTasks } from '../services/auto-tag.js';
import { suggestSubtasks } from '../agents/subtasks.js';
import { enrichTaskFromMemory } from '../services/task-enrich.js';
import { startTimer, stopTimer, getRunning } from '../services/timer.js';
import { rescheduleTask } from '../engine/review.js';
import { requestReplan } from '../engine/auto-defense.js';
import { placeStartAnchoredTask, type StartAnchoredOutcome } from '../engine/autoplan.js';
import { computeStreak } from '../engine/recurrence-ops.js';
import { objectiveIdsByTaskIds, ensureTaskPromoted } from '../services/task-promotion.js';
import { taskTagNames, taskTagNamesByIds, taskSecondaryTagNamesByIds, splitNamesByDirection, entityCategoryNames, entityCategoryNamesByIds, suggestibleVocabulary } from '../services/tags.js';
import {
  createTask, createRecurringTask, updateTask, deleteTask,
  promoteToHabit, recallTask, skipRecurringInstance,
  taskSecondaryTags, updateTouchesSchedule,
  type CreateTaskInput, type UpdateTaskInput,
} from '../services/tasks.js';
import { writeAudit } from '../lib/audit.js';
import { closeTask } from '../services/task-close.js';
import { classificationInput, logAssignment } from '../services/classification-learning.js';
import { getEntityPeople, getEntityPeopleBulk } from '../services/people.js';

// Task business logic lives in services/tasks.ts (Phase W step 3.1, shared with the
// coming GraphQL resolvers). These handlers are thin HTTP shells: parse → call the
// service → map error→status → serialize (taskToApi + tag/dep reads) → broadcast.

/**
 * GET /api/tasks has no pagination — unlike the GraphQL `tasks` connection
 * (listTasks/countTasks, keyset-paginated), it returns every matching row in one
 * response. That is a real, still-open gap (AllTasks.tsx, RoutinesPanel.tsx and the
 * central task store all currently assume "every matching task comes back," so wiring
 * real pagination through here means changing THEM too, not just this route).
 *
 * This cap is deliberately not that fix. It bounds only the pathological case — a
 * script, a seed, a bug that leaves an owner with an unbounded row count — at a
 * ceiling far above anything a real owner could ever reach by using the app: even a
 * task or two a day, every day, for a decade is a small fraction of this. No real
 * caller should ever notice it fire.
 */
const DEFAULT_TASKS_LIMIT = 20_000;

/**
 * The two people-sets, shaped for spreading into a task payload (0151).
 *
 * Single-row: fine inside an async handler, but NOT inside the synchronous `.map()`
 * the two list endpoints use — those batch through `getEntityPeopleBulk` for the same
 * reason `dependsById` is resolved up front (an async map callback puts a Promise in
 * every field and `ctx.body` serializes `{}`).
 */
async function peopleFor(taskId: string): Promise<{ responsible: unknown[]; beneficiaries: unknown[] }> {
  const { responsible, beneficiaries } = await getEntityPeople('task', taskId);
  return { responsible, beneficiaries };
}

export function tasksRouter() {
  const router = new Router();

  // GET /api/tasks
  router.get('/api/tasks', async (ctx) => {
    const { status, owner_id, tag, q, due_before, priority, include_fast, limit } = ctx.query as Record<string, string>;

    // The list is ALWAYS scoped to the current owner — a plain `db.select()` here
    // is a cross-tenant read leak (IDOR). An explicit `owner_id` param can only
    // narrow *within* the current owner (a mismatch yields no rows); the owner
    // scope is ANDed unconditionally, so it can never widen past the caller.
    const conditions = [eq(tasks.ownerId, currentOwnerId())];
    if (status)    conditions.push(eq(tasks.status, status));
    if (owner_id)  conditions.push(eq(tasks.ownerId, owner_id));
    if (priority)  conditions.push(eq(tasks.priority, Number(priority)));
    if (due_before) conditions.push(lte(tasks.dueAt, due_before));
    if (q)         conditions.push(like(tasks.title, `%${q}%`));
    // Fast tasks are ritual-local — hidden from the list unless explicitly requested.
    // Filter on the canonical subtype (W1-A); equivalent to the is_fast_task alias.
    if (include_fast !== '1') conditions.push(ne(tasks.subtype, 'quick'));

    // A caller may narrow below the default cap; nobody may raise it above — the cap
    // is the ceiling this route promises, not a suggestion a query param can override.
    const parsedLimit = Number(limit);
    const effectiveLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, DEFAULT_TASKS_LIMIT)
        : DEFAULT_TASKS_LIMIT;

    const result = await db
      .select()
      .from(tasks)
      .where(and(...conditions))
      // `id` (uuid7 — time-ordered) is a pure tiebreak: priority/dueAt alone leave
      // many rows tied, and without a stable final key a LIMIT's boundary is whichever
      // tied row the engine happens to return first — different on every call.
      .orderBy(asc(tasks.priority), asc(tasks.dueAt), asc(tasks.id))
      .limit(effectiveLimit);

    // A full page is the cheap, standard heuristic for "there may be more" — exactly
    // `effectiveLimit` real matches with nothing beyond it is indistinguishable from
    // this without a second COUNT(*) query on every request, which is a real cost to
    // pay on every call for a signal this route's only callers don't consume today.
    // `tag` filters AFTER this fetch (below) — a tag match beyond the cap is invisible
    // to it. Both are the same trade this whole cap makes: correct and unbounded, or
    // bounded with an edge a real owner will never reach.
    if (result.length === effectiveLimit) {
      logger.warn('GET /api/tasks hit its row cap — results are truncated', {
        ownerId: currentOwnerId(), limit: effectiveLimit,
      });
    }

    // Attach tags + dependency info, serialize to snake_case
    const blocked = await blockedTaskIds();
    const ids = result.map((t) => t.id);
    const tagsById = await taskTagNamesByIds(ids);
    const secondaryById = await taskSecondaryTagNamesByIds(ids);
    const categoriesById = await entityCategoryNamesByIds('task', ids); // Phase B: 1–3, position order
    const objectivesById = await objectiveIdsByTaskIds(currentOwnerId(), ids); // AF-10: ALL links (created_at,id order)
    // Resolved up front so the map below can stay synchronous — an async .map callback
    // would put a Promise in every depends_on field, and ctx.body would serialize `{}`.
    const dependsById = new Map<string, string[]>();
    for (const id of ids) dependsById.set(id, await getDependencies(id));
    const peopleById = await getEntityPeopleBulk('task', ids); // 0151: batched, same reason
    const withTags = result.map((t) => ({
      ...taskToApi(t),
      responsible: peopleById.get(t.id)?.responsible ?? [],
      beneficiaries: peopleById.get(t.id)?.beneficiaries ?? [],
      tags: tagsById.get(t.id) ?? [],
      secondary_tags: secondaryById.get(t.id) ?? [],
      categories: categoriesById.get(t.id) ?? [],
      depends_on: dependsById.get(t.id) ?? [],
      blocked: blocked.has(t.id),
      // §I star + AF-10 card picker. objective_id = objective_ids[0] ?? null (back compat).
      objective_ids: objectivesById.get(t.id) ?? [],
      objective_id: objectivesById.get(t.id)?.[0] ?? null,
    }));

    // Filter by tag after attachment (simple approach for v1). AF-11 (D1): match
    // level 1 ∪ level 2 — intentions live at level 2 since 0121, and ?tag=<intention>
    // must keep finding them (an L1-only check would silently break intention filters).
    const filtered = tag
      ? withTags.filter((t) => (t.tags as string[]).includes(tag) || (t.secondary_tags as string[]).includes(tag))
      : withTags;

    // Additive-only: existing callers read `.tasks` and stay correct without ever
    // reading `truncated`. It exists for whoever picks this cap up in the future,
    // whether that's a client-side "there may be more" affordance or a diagnostic.
    ctx.body = { tasks: filtered, truncated: result.length === effectiveLimit };
  });

  // POST /api/tasks
  router.post('/api/tasks', async (ctx) => {
    const body = ctx.request.body as CreateTaskInput;
    const owner = currentOwnerId();

    // Motivation (0141, §3b): reject junk early, and strip motivation_source — it is
    // server-derived ONLY (a client claiming 'llm' would launder its own testimony as
    // the machine's; the z_experiment_arm strip is the precedent).
    delete (body as Record<string, unknown>).motivation_source;
    if (body.motivation !== undefined && body.motivation !== null && !isMotivation(body.motivation)) {
      ctx.status = 422;
      ctx.body = { error: "motivation must be 'me', 'us', 'them', or null" };
      return;
    }

    // Recurring task → create a TEMPLATE (status 'recurring', never scheduled
    // directly) and materialize its instances now so the series appears immediately.
    if (body.recurrence_rule) {
      const res = await createRecurringTask(owner, body);
      if (!res.ok) {
        if (res.error === 'title_required') { ctx.status = 400; ctx.body = { error: 'title is required' }; return; }
        ctx.status = 422; ctx.body = { error: res.message }; return;
      }
      const out = { ...taskToApi(res.template), tags: body.tags ?? [], secondary_tags: await taskSecondaryTags(res.template.id), categories: await entityCategoryNames('task', res.template.id), depends_on: [] as string[], blocked: false, ...(await peopleFor(res.template.id)) };
      broadcast(owner, 'task:created', out);
      broadcast(owner, 'recurrence:generated', res.generated);
      ctx.status = 201;
      ctx.body = { task: out, generated: res.generated };
      return;
    }

    const res = await createTask(owner, body);
    if (!res.ok) {
      if (res.error === 'title_required') { ctx.status = 400; ctx.body = { error: 'title is required' }; return; }
      ctx.status = 409; ctx.body = { error: 'dependency cycle', detail: res.detail }; return;
    }
    let task = res.task;

    // AB1: opt-in `auto_place: true` → start-anchored placement (any trust mode).
    // Default false — the wizard client creates its own block explicitly, so an
    // unconditional hook here would double-place; the flag is for API/agent callers.
    // Runs BEFORE the payload is built: placement flips status open → scheduled (R2
    // parity), and the response/broadcast must carry the post-placement row.
    let placement: StartAnchoredOutcome | undefined;
    if (body.auto_place === true && task.scheduledFor) {
      try {
        placement = await placeStartAnchoredTask(owner, task.id);
        if (placement.placed) [task] = await db.select().from(tasks).where(and(eq(tasks.id, task.id), eq(tasks.ownerId, owner)));
      } catch (err) {
        logger.warn('auto_place: start-anchored placement failed', { owner, taskId: task.id, err: (err as Error).message });
      }
    }

    const out = {
      ...taskToApi(task),
      ...(await peopleFor(task.id)),
      tags: body.tags ?? [],
      secondary_tags: await taskSecondaryTags(task.id),
      categories: await entityCategoryNames('task', task.id),
      depends_on: await getDependencies(task.id),
      blocked: (await blockedTaskIds()).has(task.id),
    };
    broadcast(owner, 'task:created', out);
    requestReplan('task:created'); // B2: a new task can shift today's plan (debounced + toggle-gated)
    ctx.status = 201;
    ctx.body = { task: out, ...(placement ? { placement } : {}) };
  });

  // The quick-add enrichment overlay draws from the SHARED suggestible vocabulary
  // (services/tags.ts): direction / category / other, muted excluded. Its split-by-kind
  // shape is exactly QuickVocab's, so it passes straight through — and quick-add now
  // honours a mute the same way the nightly sweep always has.
  // POST /api/tasks/quick/parse — T14 (#350): the parse-only twin of /tasks/quick.
  // ZERO writes — the wizard's NL line (typed or spoken) previews the parse by
  // hydrating its own form fields, and the user approves via the wizard's Add
  // (which runs the normal create path). Same preview→confirm doctrine as
  // /plan-week/parse vs /plan/instruct (#387). Deterministic parse always succeeds;
  // the Ollama overlay is best-effort and `llm` reports truthfully whether it ran.
  // Registered BEFORE /quick only for reading order — @koa/router matches exactly.
  router.post('/api/tasks/quick/parse', async (ctx) => {
    const text = (ctx.request.body as { text?: string })?.text?.trim();
    if (!text) {
      ctx.status = 400;
      ctx.body = { error: 'text is required' };
      return;
    }

    const parsed = parseQuick(text); // deterministic, always succeeds
    let enriched = parsed;
    let llm = false;
    try {
      enriched = await enrichQuick(text, parsed, await suggestibleVocabulary(currentOwnerId())); // additive overlay
      llm = true;
    } catch {
      /* OllamaUnavailable / bad JSON → keep the deterministic parse */
    }

    ctx.body = { parsed: enriched, llm };
  });

  // POST /api/tasks/quick — natural-language quick add (deterministic + optional AI)
  router.post('/api/tasks/quick', async (ctx) => {
    const text = (ctx.request.body as { text?: string })?.text?.trim();
    if (!text) {
      ctx.status = 400;
      ctx.body = { error: 'text is required' };
      return;
    }

    const parsed = parseQuick(text); // deterministic, always succeeds
    let enriched = parsed;
    let llm = false;
    try {
      enriched = await enrichQuick(text, parsed, await suggestibleVocabulary(currentOwnerId())); // additive overlay
      llm = true;
    } catch {
      /* OllamaUnavailable / bad JSON → keep the deterministic parse */
    }

    // AF-11 Slice 2: quick-add's flat name list is leveled BY KIND — known direction
    // names land at level 1 (the single primary axis), everything else (intentions +
    // brand-new names, created with the default kind='intention') at level 2. The
    // split stays at the route (it's quick-add's parse shape, not a create rule);
    // the leveled write itself rides createTask's tags/secondary_tags.
    const { directions, others } = await splitNamesByDirection(currentOwnerId(), enriched.tags);

    // Shared create path (services/tasks.ts) — the same service POST /api/tasks uses,
    // so tag-level sync, reminders, dependency handling, parent promotion, and the
    // audit row are one code path and any future create rule applies here too.
    const res = await createTask(currentOwnerId(), {
      title: enriched.title,
      due_at: enriched.dueAt,
      scheduled_for: enriched.scheduledFor,
      task_time: enriched.taskTime,
      estimated_minutes: enriched.estimatedMinutes,
      // P1 when unsure (owner rule 2026-07-20): a captured task is important until
      // the user says otherwise — quick-add never silently files things at P3.
      priority: enriched.priority ?? 1,
      ...(enriched.tags.length ? { tags: directions, secondary_tags: others } : {}),
      // Phase B: the classifier's best-guess categories (1–3 names, best fit first)
      // ride createTask's categories field → entity_categories.
      ...(enriched.categories?.length ? { categories: enriched.categories } : {}),
      // Motivation (0141): the overlay's constrained pick, attributed to the machine —
      // quick-add is the one create path where the model already runs inline.
      ...(enriched.motivation ? { motivation: enriched.motivation, motivation_source: 'llm' as const } : {}),
    });
    if (!res.ok) {
      // Only title_required is reachable (no depends_on here) — defensive mapping.
      ctx.status = 400;
      ctx.body = { error: 'title is required' };
      return;
    }
    let task = res.task;

    // Phase 8 — record what the MODEL claimed, so a later edit becomes evidence about
    // the classifier. Only when the model actually ran (`llm`), and only for values it
    // chose: a category or motivation the PARSE carried came from the user's own typing,
    // and "correcting" your own syntax teaches nothing about the classifier.
    if (llm) {
      // Keyed on the title rather than the raw entry, so the indexed text and the text a
      // later classification queries with (title [+ notes]) live in the same space.
      const classifyText = classificationInput(enriched.title, null);
      if (!parsed.categories?.length && enriched.categories?.length) {
        await logAssignment(currentOwnerId(), {
          taskId: task.id, field: 'category', inputText: classifyText, llmValue: enriched.categories,
        });
      }
      if (!parsed.motivation && enriched.motivation) {
        await logAssignment(currentOwnerId(), {
          taskId: task.id, field: 'motivation', inputText: classifyText, llmValue: enriched.motivation,
        });
      }
    }

    // AD1: a scheduled task is placed on its day right away — task_time set → exact
    // placement; no time → that date's direction window → workday gap (owner decision).
    // placeStartAnchoredTask broadcasts 'auto:placed' on success (its non-silent path),
    // so the client refetches blocks. Best-effort: a placement failure must never fail
    // the quick-add itself (the task is already created).
    if (task.scheduledFor) {
      try {
        const placed = await placeStartAnchoredTask(currentOwnerId(), task.id);
        // Placement flips status open → scheduled (R2 parity) — re-read so the
        // response/broadcast carry the post-placement row. Owner-scoped (defense in
        // depth; matches the other owner-scoped reads in this router).
        if (placed.placed) [task] = await db.select().from(tasks).where(and(eq(tasks.id, task.id), eq(tasks.ownerId, currentOwnerId())));
      } catch (err) {
        logger.warn('quick-add: start-anchored placement failed', { owner: currentOwnerId(), taskId: task.id, err: (err as Error).message });
      }
    }

    // `tags` reflects the LEVELED result (L1 = directions), not the flat parse — so the
    // response matches what a follow-up GET returns; intentions ride in secondary_tags.
    const out = { ...taskToApi(task), tags: await taskTagNames(task.id), secondary_tags: await taskSecondaryTags(task.id), depends_on: [] as number[], blocked: false, llm, ...(await peopleFor(task.id)) };
    broadcast(currentOwnerId(), 'task:created', out);
    // No writeAudit here — createTask already wrote the 'create' audit row.
    ctx.status = 201;
    ctx.body = { task: out, parsed: enriched, llm };
  });

  // GET /api/tasks/:id/subtasks
  router.get('/api/tasks/:id/subtasks', async (ctx) => {
    const parentId = ctx.params.id;
    // Owner-scoped: a caller must never read another owner's subtree, even by
    // guessing a foreign parent id (IDOR). Subtasks share their parent's owner.
    const result = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentId, parentId), eq(tasks.ownerId, currentOwnerId())))
      .orderBy(asc(tasks.priority));
    const ids = result.map((t) => t.id);
    const tagsById = await taskTagNamesByIds(ids);
    const secondaryById = await taskSecondaryTagNamesByIds(ids);
    const objectivesById = await objectiveIdsByTaskIds(currentOwnerId(), ids); // §I: subtasks of a promoted parent are linked too — show their star
    const categoriesById = await entityCategoryNamesByIds('task', ids); // Phase B
    const peopleById = await getEntityPeopleBulk('task', ids); // 0151: batched, same reason
    const withTags = result.map((t) => ({
      ...taskToApi(t),
      responsible: peopleById.get(t.id)?.responsible ?? [],
      beneficiaries: peopleById.get(t.id)?.beneficiaries ?? [],
      tags: tagsById.get(t.id) ?? [],
      secondary_tags: secondaryById.get(t.id) ?? [],
      categories: categoriesById.get(t.id) ?? [],
      // objective_id = objective_ids[0] ?? null (back compat with the single-link shape).
      objective_ids: objectivesById.get(t.id) ?? [],
      objective_id: objectivesById.get(t.id)?.[0] ?? null,
    }));
    ctx.body = { subtasks: withTags };
  });

  // POST /api/tasks/:id/skip — skip a recurring instance: mark it `skipped` and
  // add its day to the template's EXDATE so a regenerate won't resurrect it.
  router.post('/api/tasks/:id/skip', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    const res = await skipRecurringInstance(owner, id);
    if (!res.ok) {
      ctx.status = res.error === 'not_found' ? 404 : 400;
      ctx.body = { error: res.error === 'not_found' ? 'not found' : 'not a recurring instance' };
      return;
    }
    const out = { ...taskToApi(res.task), tags: [] as string[], depends_on: [] as number[], blocked: false, ...(await peopleFor(res.task.id)) };
    broadcast(owner, 'task:updated', out);
    ctx.body = { task: out, skipped: res.skipped };
  });

  // GET /api/tasks/:id/streak — habit streak + last-7 occurrence strip for a
  // recurring task (pass a template or any instance id). 404 if not recurring.
  router.get('/api/tasks/:id/streak', async (ctx) => {
    const id = ctx.params.id;
    // Owner-scope the read first: a streak request for a task the caller doesn't
    // own must be indistinguishable from a non-recurring/absent task (same 404),
    // so a foreign id can't be probed for existence (IDOR). An instance shares
    // its template's owner, so checking the passed id is sufficient.
    const owner = currentOwnerId();
    const [owned] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.ownerId, owner)));
    if (!owned) {
      ctx.status = 404; ctx.body = { error: 'not a recurring task' }; return;
    }
    const res = await computeStreak(id);
    if (!res) { ctx.status = 404; ctx.body = { error: 'not a recurring task' }; return; }
    ctx.body = res;
  });

  // POST /api/tasks/:id/promote-habit — make a (possibly fast/ritual-local) task a
  // habit: flag it, drop fast-task hiding, and ensure its Habit-type pattern (G2).
  router.post('/api/tasks/:id/promote-habit', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    const res = await promoteToHabit(owner, id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const out = { ...taskToApi(res.task), tags: await taskTagNames(id), depends_on: await getDependencies(id), ...(await peopleFor(id)) };
    broadcast(owner, 'task:updated', out);
    broadcast(owner, 'pattern:updated', { id });
    ctx.body = { task: out };
  });

  // POST /api/tasks/:id/promote-objective — surface a task in the objectives tree as
  // its own leaf objective (title copied), linking the task + any subtasks it already
  // has. The same machinery that fires automatically when a task gains a subtask; this
  // is the manual trigger. Idempotent per task via objectives.source_task_id, so
  // promoting twice reuses the objective rather than making a second.
  // ensureTaskPromoted broadcasts and audits, so this route only maps its outcome.
  router.post('/api/tasks/:id/promote-objective', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    if (!(await store().prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(id, owner))) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    // The task exists but is ephemeral — a quick task or a materialized recurrence
    // instance. Those must not spawn a strategic objective (services/task-promotion.ts).
    const objectiveId = await ensureTaskPromoted(id, owner);
    if (!objectiveId) { ctx.status = 422; ctx.body = { error: 'not_promotable' }; return; }
    // Owner-scoped read even though ensureTaskPromoted only ever returns THIS owner's
    // objective: the route shouldn't depend on the service's internal scoping for its
    // own safety (matches every other raw read here), and an unscoped read would answer
    // 200 with a silent `{}` if the row were unreadable. Unreachable today — by design.
    const objective = await store().prepare('SELECT * FROM objectives WHERE id = ? AND owner_id = ?').get(objectiveId, owner);
    if (!objective) { ctx.status = 500; ctx.body = { error: 'objective missing' }; return; }
    ctx.body = { objective };
  });

  // POST /api/tasks/suggest-tags { title } → { tags } — best-effort LLM auto-tag for
  // the New Task wizard, constrained to existing tags. Returns [] when Ollama is down
  // (the client still has its offline heuristic). Literal path; no clash with /:id/*.
  // SUGGEST-ONLY: it writes nothing, so the wizard can rank tags while the user types.
  // The bulk sweep is /auto-tag below — do NOT rebuild it by looping this endpoint.
  router.post('/api/tasks/suggest-tags', async (ctx) => {
    const { title } = (ctx.request.body ?? {}) as { title?: string };
    // Shared suggestible vocabulary: muted excluded, and CATEGORIES excluded from the
    // offered list — a category lives in entity_categories, never entity_tags, so a
    // category pick here could only ever be discarded (same rule as the bulk sweep).
    // `directions` rides along separately so the prompt can name and define the axis.
    const vocab = await suggestibleVocabulary(currentOwnerId());
    const tags = await suggestTags(
      title ?? '',
      [...vocab.directions, ...vocab.others],
      vocab.directions,
    );
    ctx.body = { tags };
  });

  // POST /api/tasks/:id/enrich → { enriched, reason?, description?, direction?, sources? }
  // On-demand memory enrichment for ONE task (D4). Shares its whole implementation with
  // the nightly `enrich_tasks` job. Always 200: "memory is off" / "nothing related" are
  // outcomes the UI reports, not errors — the caller shows `reason` verbatim.
  router.post('/api/tasks/:id/enrich', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;
    if (!(await store().prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(id, owner))) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    const res = await enrichTaskFromMemory(owner, id);
    if (res.enriched) {
      const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, owner)));
      if (task) {
        broadcast(owner, 'task:updated', {
          ...taskToApi(task),
          ...(await peopleFor(task.id)),
          tags: await taskTagNames(id),
          secondary_tags: await taskSecondaryTags(id),
          categories: await entityCategoryNames('task', id),
          depends_on: await getDependencies(id),
          blocked: (await blockedTaskIds()).has(id),
        });
      }
      writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `task:${id}` });
    }
    ctx.body = res;
  });

  // POST /api/tasks/suggest-subtasks { title, context? } → { subtasks } — the brainstorm
  // behind the wizard's chips (D5). ZERO WRITES, and deliberately so: this endpoint can
  // only ever hand back strings, so there is no code path — here or in the agent — that
  // creates a subtask the user did not pick. Creation stays on the normal parent_id path.
  // Returns [] when Ollama is down; the wizard then shows no chips. Literal path.
  router.post('/api/tasks/suggest-subtasks', async (ctx) => {
    const { title, context } = (ctx.request.body ?? {}) as { title?: string; context?: string };
    const subtasks = await suggestSubtasks(title ?? '', typeof context === 'string' ? context : '');
    ctx.body = { subtasks };
  });

  // POST /api/tasks/auto-tag { task_ids? } → { tagged, total, log } — the Tasks view's
  // Auto-tag button. Runs the SAME service as the `tag_tasks` cron job, so button and job
  // can't drift on vocabulary (muted + category tags excluded), on the AF-11 kind split
  // (one level-1 direction, intentions at level 2), or on the idempotency gate.
  // `task_ids` narrows the sweep to what the caller has on screen; omitting it sweeps the
  // whole owner. Literal path; no clash with /:id/*.
  router.post('/api/tasks/auto-tag', async (ctx) => {
    const owner = currentOwnerId();
    const { task_ids } = (ctx.request.body ?? {}) as { task_ids?: unknown };
    // An absent/garbage list means owner-wide, but an EMPTY array must stay an empty
    // scope — "nothing selected" tags nothing, rather than silently sweeping everything.
    const scope = Array.isArray(task_ids)
      ? task_ids.filter((v): v is string => typeof v === 'string')
      : undefined;
    const res = await tagUntaggedTasks(owner, scope);

    // The service writes entity_tags directly (no updateTask call), so nothing else
    // broadcasts these — fan them out here or other open clients keep the stale tags.
    const blocked = await blockedTaskIds(); // hoisted: one dependency scan, not one per task
    for (const id of res.taggedIds) {
      const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, owner)));
      if (!task) continue;
      broadcast(owner, 'task:updated', {
        ...taskToApi(task),
        ...(await peopleFor(task.id)),
        tags: await taskTagNames(id),
        secondary_tags: await taskSecondaryTags(id),
        categories: await entityCategoryNames('task', id),
        depends_on: await getDependencies(id),
        blocked: blocked.has(id),
      });
      // One row per task, matching what the old PATCH-per-task path recorded — a bulk
      // sweep must stay as traceable in the audit log as the hand edits it replaces.
      writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `task:${id}` });
    }
    // No requestReplan: a tag edit is not scheduling-relevant (same rule as PATCH).
    ctx.body = { tagged: res.tagged, total: res.total, log: res.log };
  });

  // POST /api/tasks/:id/recall — DEAD SURFACE (zero client callers — see #392): no
  // Recall action exists in any UI; reachable only by direct API call. — clone a (usually shelved/Past) task to a brand-new
  // task (new id): carries title/tags/estimate/notes/subtype + subtasks (recursively,
  // reset to open); Routine membership only when prefs.recall_keeps_pattern. Fresh
  // dates/status; no recurrence or history. cockpit-v2 Phase 6.
  router.post('/api/tasks/:id/recall', async (ctx) => {
    const owner = currentOwnerId();
    const res = await recallTask(owner, ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const task = res.task;
    const out = { ...taskToApi(task), tags: await taskTagNames(task.id), secondary_tags: await taskSecondaryTags(task.id), depends_on: [] as string[], blocked: false, ...(await peopleFor(task.id)) };
    broadcast(owner, 'task:created', out);
    ctx.status = 201;
    ctx.body = { task: out };
  });

  // POST /api/tasks/:id/reschedule — { days }: bump a missed/planned task `days` out
  // from today. Clears 'missed', increments defer_count, drops stale blocks so it
  // re-places cleanly. LIVE since the Missed review surface shipped (Today DueCard's
  // amber "missed" rollup — its Today/+1d/+3d/+1w revive chips are the designed
  // callers; was flagged dead in #392 because that surface hadn't been built). This
  // is the scheduled_for axis ON PURPOSE — Today's overdue defer chips move due_at
  // via PATCH /tasks/:id, the deadline axis; the two affordances coexist.
  // In Schedule mode (trust_mode='hands_off') the engine also books the reopened
  // task into the next available slot on its new day; `placement` reports it.
  // Stays a thin wrapper over engine rescheduleTask (no service layer needed).
  router.post('/api/tasks/:id/reschedule', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { days?: number };
    if (typeof body.days !== 'number') { ctx.status = 422; ctx.body = { error: 'days is required' }; return; }
    if (!(await store().prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(id, owner))) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    const { scheduled_for, placement } = await rescheduleTask(id, body.days, owner);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    const out = { ...taskToApi(task), tags: await taskTagNames(id), depends_on: await getDependencies(id), ...(await peopleFor(id)) };
    broadcast(owner, 'task:updated', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'reschedule', entity: `task:${id}` });
    broadcast(owner, 'block:updated', { rescheduled: id });
    ctx.body = { task: out, scheduled_for, ...(placement ? { placement } : {}) };
  });

  // PATCH /api/tasks/:id
  router.patch('/api/tasks/:id', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    // Accept both snake_case (client/API convention) and camelCase (drizzle) field names.
    const body = (ctx.request.body ?? {}) as UpdateTaskInput;

    // Motivation (0141): same early validation as POST; a PATCHed value is user
    // testimony (the service stamps motivation_source='user'), null un-labels.
    delete (body as Record<string, unknown>).motivation_source;
    if (body.motivation !== undefined && body.motivation !== null && !isMotivation(body.motivation)) {
      ctx.status = 422;
      ctx.body = { error: "motivation must be 'me', 'us', 'them', or null" };
      return;
    }

    // scope=series edits the whole recurring series (the template); scope=instance
    // (default) edits just this row. For a non-recurring task the two coincide.
    const scope = (ctx.query.scope as string) === 'series' ? 'series' : 'instance';

    const res = await updateTask(owner, id, body, scope);
    if (!res.ok) {
      if (res.error === 'invalid_rule') { ctx.status = 422; ctx.body = { error: res.message }; return; }
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      // dependency_cycle: the column UPDATE already applied before the dependency change
      // was rejected; the service now stamps it internally (Phase-L versioning, moved in
      // at W3.3b so GraphQL updates version too).
      ctx.status = 409; ctx.body = { error: 'dependency cycle', detail: res.detail }; return;
    }

    // Phase L: version/field_ts stamping now lives INSIDE updateTask (W3.3b), so REST +
    // GraphQL both version their column writes; the route no longer stamps.

    // REQ2 (reverse sync): the service moved the placed block in lockstep.
    if (res.syncedBlockId) broadcast(owner, 'block:updated', { id: res.syncedBlockId });
    // Task→block done-state mirror: checking the task off completed its block(s) (or a
    // reopen revived them) — tell the Planner to refresh each.
    for (const blockId of res.mirroredBlockIds) broadcast(owner, 'block:updated', { id: blockId });
    // Clearing the start intent unscheduled the task (its block was removed) — tell the
    // Planner to drop it.
    if (res.unscheduled) broadcast(owner, 'block:updated', { unscheduled: id });

    const out = {
      ...taskToApi(res.task),
      ...(await peopleFor(res.task.id)),
      tags: await taskTagNames(res.targetId),
      secondary_tags: await taskSecondaryTags(res.targetId),
      categories: await entityCategoryNames('task', res.targetId),
      depends_on: await getDependencies(res.targetId),
      blocked: (await blockedTaskIds()).has(res.targetId),
    };
    broadcast(owner, 'task:updated', out);
    if (res.generated) broadcast(owner, 'recurrence:generated', res.generated);
    // B2: only a scheduling-relevant column change can re-order the day — a title/notes/
    // tag edit must not churn the plan (and, pre-AE, could surface the reflow wipe).
    if (updateTouchesSchedule(res.updatedFields)) requestReplan('task:updated');
    ctx.body = { task: out, ...(res.generated ? { generated: res.generated } : {}) };
  });

  // DELETE /api/tasks/:id  (soft delete)
  router.delete('/api/tasks/:id', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    // ?scope=following also truncates the recurring series at this occurrence.
    const scope = (ctx.query.scope as string) === 'following' ? 'following' : 'instance';
    const res = await deleteTask(owner, id, scope);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const out = { ...taskToApi(res.task), tags: [] as string[], ...(await peopleFor(res.task.id)) };
    broadcast(owner, 'task:updated', out);
    for (const blockId of res.cancelledBlockIds) broadcast(owner, 'block:updated', { id: blockId });
    requestReplan('task:deleted'); // B2: a cancelled task frees its slot — re-pack the day
    ctx.body = { task: out };
  });

  // POST /api/tasks/:id/timer/start — start a timer (optionally linked to a block).
  // Stops any running timer first (one per owner); broadcasts the superseded
  // entry's stop, then the new start. 201 with the new entry.
  router.post('/api/tasks/:id/timer/start', async (ctx) => {
    const taskId = ctx.params.id;
    const blockId = (ctx.request.body as { block_id?: number } | undefined)?.block_id;
    const { entry, stopped } = await startTimer(taskId, blockId);
    const owner = currentOwnerId();
    if (stopped) {
      broadcast(owner, 'timer:stopped', stopped.entry); // the superseded one
      if (stopped.overran) broadcast(owner, 'block:updated', { id: stopped.entry.block_id });
    }
    broadcast(owner, 'timer:started', entry);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'timer:start', entity: `task:${taskId}` });
    ctx.status = 201;
    ctx.body = { entry };
  });

  // POST /api/tasks/:id/close { mood?, note?, actual_minutes? } — the close ritual.
  // Completes the task if it is still open, records an optional mood/note, and stamps
  // reaction_at (only when a mood or note was actually given — see services/task-close.ts).
  // Also accepted on an ALREADY-DONE task, which is the point: reflecting later is normal,
  // and the completed_at ↔ reaction_at gap is what makes the lag measurable.
  router.post('/api/tasks/:id/close', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;
    const body = (ctx.request.body ?? {}) as { mood?: unknown; note?: unknown; actual_minutes?: unknown };
    const res = await closeTask(owner, id, { mood: body.mood, note: body.note, actualMinutes: body.actual_minutes });
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, owner)));
    const out = {
      ...taskToApi(task),
      ...(await peopleFor(task.id)),
      tags: await taskTagNames(id),
      secondary_tags: await taskSecondaryTags(id),
      categories: await entityCategoryNames('task', id),
      depends_on: await getDependencies(id),
      blocked: (await blockedTaskIds()).has(id),
    };
    broadcast(owner, 'task:updated', out);
    ctx.body = { task: out, closed: { completed_at: res.completedAt, reaction_at: res.reactionAt, mood: res.mood, actual_minutes: res.actualMinutes } };
  });

  // POST /api/tasks/:id/timer/stop — stop the (single) running timer. 409 when
  // none is running (deterministic, safe for a double-click). :id is ignored —
  // there is only ever one running entry per owner.
  router.post('/api/tasks/:id/timer/stop', async (ctx) => {
    const res = await stopTimer();
    if (!res) {
      ctx.status = 409;
      ctx.body = { error: 'no running timer' };
      return;
    }
    const owner = currentOwnerId();
    broadcast(owner, 'timer:stopped', res.entry);
    broadcast(owner, 'task:updated', { id: res.taskId, actual_minutes: res.actualMinutes });
    if (res.overran) {
      broadcast(owner, 'block:updated', { id: res.entry.block_id });
      // §C1 (docs/M-ai-scheduler.md:322): an overrun shifts the day's obstacles — request a
      // reactive reflow so the remaining blocks re-pack around the long-running one
      // (debounced + toggle-gated; never throws into this handler).
      requestReplan('overrun', owner);
    }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'timer:stop', entity: `task:${res.taskId}` });
    ctx.body = { entry: res.entry, actual_minutes: res.actualMinutes };
  });

  // GET /api/timer — the current running entry (for reload/restart recovery), or null.
  router.get('/api/timer', async (ctx) => {
    ctx.body = { entry: (await getRunning(currentOwnerId())) ?? null };
  });

  return router;
}
