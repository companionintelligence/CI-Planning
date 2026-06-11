import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { db, sqlite } from './db/index.js';
import { tasks, possibleTasks } from './db/schema.js';
import { eq, and, like, asc, lte } from 'drizzle-orm';
import { toApi } from './lib/serialize.js';
import { summarizeDay } from './agents/summarize.js';
import { runScheduler } from './engine/scheduler.js';
import { fileURLToPath } from 'node:url';

export const mcpServer = new Server(
  {
    name: 'companion-planning',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function attachTags(taskId: number, names: string[]) {
  for (const rawName of names) {
    const name = rawName.toLowerCase().replace(/\s+/g, '-').slice(0, 32);
    const existing = sqlite.prepare('SELECT id FROM tags WHERE name = @name').get({ name }) as { id: number } | undefined;
    let tagId: number;
    if (existing) {
      tagId = existing.id;
    } else {
      const r = sqlite.prepare('INSERT INTO tags (name) VALUES (?) RETURNING id').get(name) as { id: number };
      tagId = r.id;
    }
    sqlite.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tagId);
  }
}

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_tasks',
        description: 'List planning tasks from the database with optional filters.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter by status (open, scheduled, in_progress, done, cancelled, deferred)' },
            priority: { type: 'number', description: 'Filter by priority (1 is highest, 5 is lowest)' },
            q: { type: 'string', description: 'Search query for matching in title' },
            limit: { type: 'number', description: 'Max number of tasks to return (default 50)' }
          }
        }
      },
      {
        name: 'create_task',
        description: 'Create a new task in the database.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The title of the task' },
            description: { type: 'string', description: 'A brief description' },
            notes: { type: 'string', description: 'Detailed free-form notes' },
            due_at: { type: 'string', description: 'ISO 8601 datetime string' },
            task_time: { type: 'string', description: 'HH:MM time-of-day for fixed time task' },
            estimated_minutes: { type: 'number', description: 'Estimated execution duration' },
            priority: { type: 'number', description: 'Priority level (1 highest, 5 lowest, default 3)' },
            parent_id: { type: 'number', description: 'ID of parent task for creating subtasks' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Array of tags' }
          },
          required: ['title']
        }
      },
      {
        name: 'update_task',
        description: 'Update an existing task by its ID.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The task ID to update' },
            title: { type: 'string' },
            description: { type: 'string' },
            notes: { type: 'string' },
            due_at: { type: 'string' },
            task_time: { type: 'string' },
            estimated_minutes: { type: 'number' },
            priority: { type: 'number' },
            status: { type: 'string' },
            completed: { type: 'boolean', description: 'Set to true to mark task complete' },
            parent_id: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['id']
        }
      },
      {
        name: 'propose_task',
        description: 'Propose a task to be placed in the user review queue (suggested/possible tasks). Use this to keep humans in the loop.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The raw proposed title' },
            description: { type: 'string', description: 'The proposed summary or detail' },
            proposed_due_at: { type: 'string', description: 'ISO 8601 proposed due date' },
            proposed_priority: { type: 'number', description: 'Proposed priority' },
            source_kind: { type: 'string', description: 'Source type, e.g., agent, email' },
            source_ref: { type: 'string', description: 'External reference, e.g. email ID' },
            confidence: { type: 'number', description: 'Confidence score from 0.0 to 1.0' }
          },
          required: ['title']
        }
      },
      {
        name: 'get_day_summary',
        description: 'Fetch the AI-generated daily briefing/summary prose for a specific date.',
        inputSchema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'ISO YYYY-MM-DD date' }
          }
        }
      },
      {
        name: 'run_auto_schedule',
        description: 'Trigger the block scheduling engine to calculate time blocks for a given day.',
        inputSchema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'ISO YYYY-MM-DD date' }
          }
        }
      }
    ]
  };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const typedArgs = (args ?? {}) as Record<string, any>;

  try {
    switch (name) {
      case 'list_tasks': {
        const { status, priority, q, limit = 50 } = typedArgs;
        let query = db.select().from(tasks);
        const conditions = [];
        if (status) conditions.push(eq(tasks.status, status));
        if (priority) conditions.push(eq(tasks.priority, Number(priority)));
        if (q) conditions.push(like(tasks.title, `%${q}%`));

        const result = conditions.length
          ? await query.where(and(...conditions)).orderBy(asc(tasks.priority), asc(tasks.dueAt))
          : await query.orderBy(asc(tasks.priority), asc(tasks.dueAt));

        const slicedResult = result.slice(0, Number(limit));

        const withTags = slicedResult.map((t) => {
          const tagRows = sqlite
            .prepare('SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = @task_id')
            .all({ task_id: t.id }) as { name: string }[];
          return { ...toApi(t), tags: tagRows.map((r) => r.name) };
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(withTags, null, 2) }]
        };
      }

      case 'create_task': {
        const { title, description, notes, due_at, task_time, estimated_minutes, priority, parent_id, tags: tagNames } = typedArgs;

        if (!title?.trim()) {
          throw new Error('Title is required');
        }

        const [task] = await db
          .insert(tasks)
          .values({
            title: title.trim(),
            description,
            notes,
            dueAt: due_at,
            taskTime: task_time,
            estimatedMinutes: estimated_minutes,
            priority: priority ?? 3,
            parentId: parent_id,
            ownerId: 1, // Default owner ID
          })
          .returning();

        if (tagNames?.length) {
          await attachTags(task.id, tagNames);
        }

        const out = { ...toApi(task), tags: tagNames ?? [] };
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }]
        };
      }

      case 'update_task': {
        const { id, title, description, notes, due_at, task_time, estimated_minutes, priority, status, completed, parent_id, tags: tagNames } = typedArgs;

        if (!id) {
          throw new Error('ID is required');
        }

        const update: Partial<typeof tasks.$inferInsert> = {};
        if (title !== undefined) update.title = title;
        if (description !== undefined) update.description = description;
        if (notes !== undefined) update.notes = notes;
        if (due_at !== undefined) update.dueAt = due_at;
        if (task_time !== undefined) update.taskTime = task_time;
        if (estimated_minutes !== undefined) update.estimatedMinutes = estimated_minutes;
        if (priority !== undefined) update.priority = priority;
        if (status !== undefined) update.status = status;
        if (parent_id !== undefined) update.parentId = parent_id;
        if (completed) {
          update.status = 'done';
          update.completedAt = new Date().toISOString();
        }

        const [task] = await db.update(tasks).set(update).where(eq(tasks.id, id)).returning();
        if (!task) {
          throw new Error(`Task with ID ${id} not found`);
        }

        if (Array.isArray(tagNames)) {
          sqlite.prepare('DELETE FROM task_tags WHERE task_id = ?').run(id);
          await attachTags(id, tagNames);
        }

        const currentTags = (sqlite
          .prepare('SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = @task_id')
          .all({ task_id: id }) as { name: string }[]).map((r) => r.name);

        const out = { ...toApi(task), tags: currentTags };
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }]
        };
      }

      case 'propose_task': {
        const { title, description, proposed_due_at, proposed_priority, source_kind = 'agent', source_ref, confidence = 1.0 } = typedArgs;

        if (!title?.trim()) {
          throw new Error('Title is required');
        }

        const [possible] = await db
          .insert(possibleTasks)
          .values({
            rawTitle: title.trim(),
            rawSummary: description,
            proposedDueAt: proposed_due_at,
            proposedPriority: proposed_priority ?? 3,
            proposedOwnerId: 1,
            sourceKind: source_kind,
            sourceRef: source_ref,
            confidence: Number(confidence),
            status: 'pending',
          })
          .returning();

        return {
          content: [{ type: 'text', text: JSON.stringify(toApi(possible), null, 2) }]
        };
      }

      case 'get_day_summary': {
        const { date } = typedArgs;
        const day = date ?? new Date().toISOString().slice(0, 10);
        const result = await summarizeDay(day);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }

      case 'run_auto_schedule': {
        const { date } = typedArgs;
        const day = date ?? new Date().toISOString().slice(0, 10);
        const result = await runScheduler(day);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: (err as Error).message }]
    };
  }
});

// Self-execute stdio transport if started directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (process.argv.includes('--stdio') || isMain) {
  console.error("Starting Companion Planning MCP Server in Stdio mode...");
  const transport = new StdioServerTransport();
  mcpServer.connect(transport).catch((err) => {
    console.error("Failed to start stdio MCP transport:", err);
  });
}
