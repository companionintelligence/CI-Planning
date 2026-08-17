import { createSignal, createMemo, For, Show } from 'solid-js';
import { X, Plus } from 'lucide-solid';
import { api, type Person, type AccountRosterEntry } from '../lib/api.js';
import { showToast } from '../stores/index.js';

/**
 * One field, used twice: Responsible and Beneficiaries (docs/people-on-work.md).
 *
 * "Both should allow the user to identify people in the same way" is the whole point —
 * so this component is shared verbatim between the two, and the only thing that differs
 * between them is the label and which set is being edited.
 *
 * The three shortcuts are EXPANSION ACTIONS, not stored modes. Each fills the set; every
 * chip stays individually removable afterwards, and the set is the truth:
 *
 *   me    → { you }
 *   us    → { you } ∪ { every known account }, picker left open to add more
 *   them  → picker open, you excluded
 *
 * What separates `us` from `them` is whether YOU are in the set, not whether the others
 * hold accounts. Both shortcuts open the same picker, and the picker always offers both
 * populations: accounts, named people, and type-to-add. With a single sign-on account
 * `us` still means you + another person — the roster is simply empty and the named
 * people carry it.
 */

export type PeopleShortcut = 'me' | 'us' | 'them';

/** True when this person was put on the item by detection rather than by the owner.
 *  `attachment_source` is absent on directory reads, so a freshly-picked person (no
 *  attachment yet) is correctly NOT machine-attached. */
function isMachineAttached(p: Person): boolean {
  return p.attachment_source != null && p.attachment_source !== 'user';
}

export function PeopleField(props: {
  label: string;
  /** Currently attached, in position order. Index 0 of Responsible is the lead. */
  value: Person[];
  onChange: (people: Person[]) => void;
  /** The whole directory (a resource shared by both fields — one fetch, not two). */
  directory: Person[];
  roster: AccountRosterEntry[];
  /** Refetch after a create so the other field sees the new person too. */
  onDirectoryChanged: () => void;
  /** Renders a "(suggested)" hint until the user touches the field. */
  suggested?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const self = () => props.directory.find((p) => p.is_self);
  const has = (id: string) => props.value.some((p) => p.id === id);

  /** Append, preserving order and never duplicating. */
  const add = (people: Person[]) => {
    const next = [...props.value];
    for (const p of people) if (!next.some((x) => x.id === p.id)) next.push(p);
    props.onChange(next);
  };

  const remove = (id: string) => props.onChange(props.value.filter((p) => p.id !== id));

  /**
   * Resolve an account to its directory row, creating it on first pick. This is the
   * write that a user action justifies — the roster GET stays pure.
   */
  async function personForAccount(entry: AccountRosterEntry): Promise<(Person & { created?: boolean }) | null> {
    if (entry.person_id) {
      const found = props.directory.find((p) => p.id === entry.person_id);
      if (found) return found;
    }
    try {
      const { person } = await api.people.fromAccount(entry.account_id);
      // Deliberately does NOT refetch here — the caller does it once for the batch.
      return { ...person, created: true };
    } catch (err) {
      showToast((err as Error).message, 'error');
      return null;
    }
  }

  async function applyShortcut(kind: PeopleShortcut) {
    setBusy(true);
    try {
      const me = self();
      if (kind === 'me') {
        if (me) props.onChange([me]);
        setOpen(false);
        return;
      }
      if (kind === 'them') {
        // Fills nothing on its own — "others, not you" is a statement about who the
        // picker should offer, and only the user can say which others.
        props.onChange(props.value.filter((p) => !p.is_self));
        setOpen(true);
        return;
      }
      // `us` — you, plus every account we know about, ON TOP of whoever is already
      // here. ADDITIVE, not a rebuild: a named person the user added by hand (the wife
      // with no login) must survive tapping `us`, or the shortcut silently deletes the
      // very case the two-population design exists for.
      //
      // On a single-account install the roster is empty, so this seeds you and leaves
      // the picker open for the named people who complete the set — `us` must never
      // quietly resolve to `me`.
      // `collect`, not `add` — the component-level `add` commits through onChange, and
      // shadowing it here with different semantics is how a later edit silently drops a
      // write.
      const resolved: Person[] = [...props.value];
      const collect = (person: Person) => {
        if (!resolved.some((p) => p.id === person.id)) resolved.push(person);
      };
      if (me) collect(me);
      // Resolved concurrently, and the directory refetched ONCE afterwards — a
      // per-account refetch inside the loop is N full directory reads for one tap.
      const people = await Promise.all(props.roster.map((entry) => personForAccount(entry)));
      for (const person of people) if (person && !person.is_self) collect(person);
      if (people.some((x) => x?.created)) props.onDirectoryChanged();
      props.onChange(resolved);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  /** Directory rows matching the query, minus anyone already attached. */
  const matches = createMemo(() => {
    const q = query().trim().toLowerCase();
    return props.directory
      .filter((p) => !has(p.id))
      .filter((p) => !q || p.display_name.toLowerCase().includes(q) || p.emails.some((e) => e.includes(q)))
      .slice(0, 8);
  });

  /** Offer "Create <name>" only for a genuinely new name. */
  const canCreate = createMemo(() => {
    const q = query().trim();
    return q.length > 0 && !props.directory.some((p) => p.display_name.toLowerCase() === q.toLowerCase());
  });

  async function createAndAdd() {
    const name = query().trim();
    if (!name) return;
    setBusy(true);
    try {
      const { person } = await api.people.create({ display_name: name });
      add([person]);
      props.onDirectoryChanged();
      setQuery('');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const pill = 'text-xs px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap';
  const chipOn = 'border-primary text-primary bg-primary/10';
  const chipOff = 'border-border text-muted-foreground hover:text-foreground';

  return (
    <div class="flex flex-col gap-1.5">
      <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
        {props.label}
        {/* Only a set the MACHINE attached reads as a suggestion. Keying this off
            "untouched this session" relabelled the user's own curated picks as guesses
            every time the wizard reopened. */}
        <Show when={props.suggested && props.value.length > 0 && props.value.every(isMachineAttached)}>
          <span class="normal-case tracking-normal text-muted-foreground"> (suggested)</span>
        </Show>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        {/* Shortcuts. `us` is shown even with one account — see the header note. */}
        <For each={['me', 'us', 'them'] as const}>
          {(kind) => (
            <button
              type="button"
              disabled={busy()}
              onClick={() => void applyShortcut(kind)}
              class={`${pill} ${chipOff} disabled:opacity-50`}
              title={
                kind === 'me' ? 'Just you'
                : kind === 'us' ? 'You and others'
                : 'Others, not you'
              }
            >
              {kind}
            </button>
          )}
        </For>

        <For each={props.value}>
          {(person) => (
            <span class={`${pill} ${chipOn} inline-flex items-center gap-1`}>
              {person.display_name}
              <Show when={!person.confirmed}>
                {/* Provisional: created from an invite or a mail header, never confirmed. */}
                <span class="opacity-60" title="Detected automatically — confirm in Settings → People">?</span>
              </Show>
              <button type="button" onClick={() => remove(person.id)} aria-label={`Remove ${person.display_name}`}>
                <X size={11} />
              </button>
            </span>
          )}
        </For>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          class="text-xs px-2 py-1 rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
          aria-expanded={open()}
        >
          <Plus size={11} /> Add
        </button>
      </div>

      <Show when={open()}>
        <div class="rounded-md border border-border bg-popover p-2 flex flex-col gap-1.5">
          <input
            class="w-full bg-transparent border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary"
            placeholder="Search or type a name…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate()) { e.preventDefault(); void createAndAdd(); } }}
          />
          <div class="flex flex-col max-h-40 overflow-auto">
            <For each={matches()}>
              {(person) => (
                <button
                  type="button"
                  onClick={() => { add([person]); setQuery(''); }}
                  class="flex items-center justify-between gap-2 text-left text-xs px-1.5 py-1 rounded hover:bg-primary/10 transition-colors"
                >
                  <span class="truncate text-foreground">{person.display_name}</span>
                  <span class="text-[10px] text-muted-foreground flex-shrink-0">
                    {person.is_self ? 'you' : person.account_id ? 'account' : person.emails[0] ?? ''}
                  </span>
                </button>
              )}
            </For>
            <Show when={matches().length === 0 && !canCreate()}>
              <p class="text-[11px] text-muted-foreground px-1.5 py-1">Everyone here is already on it.</p>
            </Show>
          </div>
          {/* Always the last row, so a brand-new name is one keystroke away — the
              directory should never be a prerequisite for naming somebody. */}
          <Show when={canCreate()}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void createAndAdd()}
              class="text-left text-xs px-1.5 py-1 rounded hover:bg-primary/10 text-primary transition-colors disabled:opacity-50"
            >
              Create “{query().trim()}”
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
