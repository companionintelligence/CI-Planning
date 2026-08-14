/**
 * FOCUS × Time Blocks, Phase 2 — grouping the day's list into Time-Block sections.
 *
 * Focus is a flat, time-ordered list of doable things. A Time Block is not a doing —
 * it is a container — so it becomes a SECTION, and the task blocks parented to it
 * nest inside instead of appearing as flat rows beside it. Sections and loose rows
 * interleave chronologically, so the list still reads as "the day in order".
 *
 * Pure and structurally typed (no `Block`/`Entry` import) so the ordering, the
 * grouping, and the past/upcoming rule are unit-testable without jsdom or the stores.
 *
 * IDENTITY IS PART OF THE CONTRACT. Grouping deliberately takes no clock: the items
 * it returns must stay referentially stable while the underlying rows are unchanged,
 * because Solid's `<For>` keys by reference and re-creates any row whose object
 * identity changed. Baking a `past` flag in here (computed from `now`) meant a fresh
 * object every 30-second tick, which tore down and rebuilt every row in the view —
 * wiping whatever the owner was typing into a section's add box. Pastness is a
 * question you ask AT RENDER TIME (`itemPast`), not a field you allocate.
 */

/** What grouping needs from a row: where it sits, whether it's finished, whose it is. */
export interface SectionMember {
  sortMin: number;
  endMs: number | null;
  done: boolean;
  /** The Time Block this row belongs to, if any. */
  parentBlockId: string | null;
}

/** What grouping needs from a Time Block. */
export interface SectionContainer {
  id: string;
  sortMin: number;
  endMs: number | null;
}

export interface BuiltSection<M, C> {
  container: C;
  members: M[];
  sortMin: number;
  /** Progress for the header — "2/5 done". Clock-independent, so it lives here. */
  doneCount: number;
  total: number;
}

export type FocusItem<M, C> =
  | { kind: 'loose'; sortMin: number; member: M }
  | { kind: 'section'; sortMin: number; section: BuiltSection<M, C> };

/** A row is behind you when it's finished, or its slot has fully elapsed. */
export function memberPast(m: SectionMember, nowMs: number): boolean {
  return m.done || (m.endMs != null && m.endMs <= nowMs);
}

/**
 * A section is past when its span has fully elapsed, or when it has members and
 * every one of them is done. An EMPTY container is past only once its time has
 * passed — there is nothing in it to have finished, and 0-of-0 must not read as
 * completion or a new empty Time Block would drop into "earlier" immediately.
 */
export function sectionPast<M extends SectionMember, C extends SectionContainer>(
  s: BuiltSection<M, C>,
  nowMs: number,
): boolean {
  const elapsed = s.container.endMs != null && s.container.endMs <= nowMs;
  return elapsed || (s.total > 0 && s.doneCount === s.total);
}

/** Pastness of either kind of item. Members travel with their section. */
export function itemPast<M extends SectionMember, C extends SectionContainer>(
  it: FocusItem<M, C>,
  nowMs: number,
): boolean {
  return it.kind === 'loose' ? memberPast(it.member, nowMs) : sectionPast(it.section, nowMs);
}

/**
 * Build the display list: loose rows and Time-Block sections, interleaved by start.
 *
 * A member is claimed by a container only when that container is on this list —
 * an orphan whose Time Block isn't here stays a loose row rather than vanishing,
 * the same rule the Calendar's containment split uses.
 *
 * Members always travel WITH their section (see `itemPast`): splitting a container's
 * tasks across "earlier" and "upcoming" would show the same Time Block twice and
 * break the containment the section exists to express.
 */
export function buildFocusItems<M extends SectionMember, C extends SectionContainer>(
  members: M[],
  containers: C[],
): FocusItem<M, C>[] {
  const byContainer = new Map<string, M[]>();
  for (const c of containers) byContainer.set(c.id, []);

  const items: FocusItem<M, C>[] = [];
  for (const m of members) {
    const claimed = m.parentBlockId != null ? byContainer.get(m.parentBlockId) : undefined;
    if (claimed) claimed.push(m);
    else items.push({ kind: 'loose', sortMin: m.sortMin, member: m });
  }

  for (const c of containers) {
    const mem = (byContainer.get(c.id) ?? []).slice().sort((a, b) => a.sortMin - b.sortMin);
    items.push({
      kind: 'section',
      sortMin: c.sortMin,
      section: {
        container: c,
        members: mem,
        sortMin: c.sortMin,
        doneCount: mem.filter((m) => m.done).length,
        total: mem.length,
      },
    });
  }

  return items.sort((a, b) => a.sortMin - b.sortMin);
}

/** How many rows sit behind the "N earlier" summary — members of past sections count. */
export function countPastRows<M extends SectionMember, C extends SectionContainer>(
  items: FocusItem<M, C>[],
  nowMs: number,
): { rows: number; done: number } {
  let rows = 0;
  let done = 0;
  for (const it of items) {
    if (!itemPast(it, nowMs)) continue;
    if (it.kind === 'loose') {
      rows += 1;
      if (it.member.done) done += 1;
    } else {
      rows += it.section.total;
      done += it.section.doneCount;
    }
  }
  return { rows, done };
}
