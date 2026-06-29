/**
 * Minimal, dependency-free iCalendar (RFC 5545) generator for exporting Time Blocks
 * as a portable `.ics` file. The format is small and well-specified, the client has
 * no blob/download helper, and `request<T>` is JSON-only — so a hand-rolled string +
 * a plain download link is the right fit (no dependency, fully unit-testable).
 *
 * Timestamps are emitted as UTC `Z` instants (blocks already store UTC ISO); calendar
 * clients localize on import, so a one-shot export needs no VTIMEZONE. Stable UIDs
 * (`<id>@companion.planning`) mean a re-import updates events instead of duplicating.
 */

/** The block fields the generator reads (the snake_case read-API shape). */
export interface ICalBlock {
  id: string;
  title: string;
  start_at: string;            // UTC ISO
  end_at: string;              // UTC ISO
  all_day?: boolean | null;
  tag?: string | null;
  secondary_tags?: string[] | null;
  rationale?: string | null;
  status?: string | null;
}

export interface ICalOptions {
  calName?: string;
  /** Injectable "now" for a deterministic DTSTAMP in tests. */
  now?: Date;
}

const PRODID = '-//Companion Planning//EN';

const pad2 = (n: number) => String(n).padStart(2, '0');
const pad4 = (n: number) => String(n).padStart(4, '0');

/** UTC instant → iCal UTC date-time: `YYYYMMDDTHHMMSSZ`. */
export function toICalUTC(iso: string): string {
  const d = new Date(iso);
  return (
    pad4(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
    'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z'
  );
}

/** UTC instant → iCal floating DATE (all-day): `YYYYMMDD`. */
export function toICalDate(iso: string): string {
  const d = new Date(iso);
  return pad4(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
}

/** Escape per RFC 5545 TEXT: backslash, semicolon, comma, and newlines (→ `\n`). */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

/**
 * Fold a content line to ≤75 octets per RFC 5545 §3.1: continuation lines begin with
 * a single space. Octet-based over UTF-8 so a multi-byte codepoint is never split.
 */
export function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const dec = new TextDecoder();
  const out: string[] = [];
  let start = 0;
  let limit = 75; // first line: 75 octets; continuations lose one to the leading space
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off so we never cut inside a UTF-8 sequence (continuation byte = 0b10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(dec.decode(bytes.subarray(start, end)));
    start = end;
    limit = 74;
  }
  return out.join('\r\n ');
}

/** The next UTC calendar day of an instant — for an all-day event's exclusive DTEND. */
function nextDayISO(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** DESCRIPTION body: the "why now" rationale + a non-default status, when present. */
function describe(b: ICalBlock): string {
  const parts: string[] = [];
  if (b.rationale) parts.push(`Why now: ${b.rationale}`);
  if (b.status && b.status !== 'planned') parts.push(`Status: ${b.status}`);
  return parts.join('\n');
}

function event(b: ICalBlock, dtstamp: string): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${b.id}@companion.planning`, `DTSTAMP:${dtstamp}`];
  if (b.all_day) {
    const startDate = toICalDate(b.start_at);
    const endDate = b.end_at ? toICalDate(b.end_at) : startDate;
    // DTEND is exclusive → the day after the last covered day (≥ the start day).
    const lastDay = endDate > startDate ? b.end_at : b.start_at;
    lines.push(`DTSTART;VALUE=DATE:${startDate}`, `DTEND;VALUE=DATE:${toICalDate(nextDayISO(lastDay))}`);
  } else {
    lines.push(`DTSTART:${toICalUTC(b.start_at)}`, `DTEND:${toICalUTC(b.end_at)}`);
  }
  lines.push(`SUMMARY:${escapeText(b.title || 'Untitled')}`);
  const desc = describe(b);
  if (desc) lines.push(`DESCRIPTION:${escapeText(desc)}`);
  // CATEGORIES: comma SEPARATED; commas inside a name are escaped by escapeText.
  const cats = [b.tag, ...(b.secondary_tags ?? [])].filter((x): x is string => !!x);
  if (cats.length) lines.push(`CATEGORIES:${cats.map(escapeText).join(',')}`);
  lines.push('END:VEVENT');
  return lines;
}

/** Build a complete VCALENDAR string (CRLF line endings, folded) for the blocks. */
export function blocksToICal(blocks: ICalBlock[], opts: ICalOptions = {}): string {
  const dtstamp = toICalUTC((opts.now ?? new Date()).toISOString());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(opts.calName ?? 'Companion Planning')}`,
  ];
  for (const b of blocks) lines.push(...event(b, dtstamp));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
