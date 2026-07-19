/**
 * Pure, dependency-free serializers for the Settings → Logs tab (T6). Turns a
 * `PlanningSession` (T1's shape — `transcript` entries are `{role: 'system'|'user',
 * text, ts, kind?}`, NOT `{role, content, created_at}` as an earlier draft of this
 * ticket assumed) into a downloadable JSON or Markdown file. No DOM, no fetch — the
 * Settings view owns the Blob/anchor download mechanics; this module only builds the
 * string content and the filename.
 */
import type { PlanningSession } from './api.js';

const ROLE_LABEL: Record<PlanningSession['transcript'][number]['role'], string> = {
  system: 'System',
  user: 'You',
};

/**
 * Deterministic Markdown: an H1 (entry branch + the session's start date), a
 * metadata line (status, started/ended timestamps), then one blank-line-separated
 * block per transcript turn (`**Role** · <ts>` then the text). An empty transcript
 * still produces the header — never throws.
 */
export function sessionToMarkdown(session: PlanningSession): string {
  const lines: string[] = [];
  lines.push(`# ${session.entry_branch} · ${session.started_at.slice(0, 10)}`);
  lines.push('');
  lines.push(
    `Status: ${session.status} · Started: ${session.started_at}${session.ended_at ? ` · Ended: ${session.ended_at}` : ''}`,
  );
  if (session.summary) {
    lines.push('');
    lines.push(session.summary);
  }
  for (const turn of session.transcript) {
    lines.push('');
    lines.push(`**${ROLE_LABEL[turn.role]}** · ${turn.ts}`);
    lines.push('');
    lines.push(turn.text);
  }
  return lines.join('\n');
}

/** The session, verbatim, pretty-printed — round-trips through `JSON.parse`. */
export function sessionToJson(session: PlanningSession): string {
  return JSON.stringify(session, null, 2);
}

/** `plan-week-<started-date>-<id>.<ext>` — deterministic, no path separators or spaces. */
export function exportFilename(session: Pick<PlanningSession, 'started_at' | 'id'>, ext: 'json' | 'md'): string {
  return `plan-week-${session.started_at.slice(0, 10)}-${session.id}.${ext}`;
}
