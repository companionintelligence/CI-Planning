import { createResource, createSignal, For, Show } from 'solid-js';
import { Trash2, Check, X, Merge, UserPlus } from 'lucide-solid';
import { api, type Person } from '../lib/api.js';
import { showToast } from '../stores/index.js';

/**
 * The person directory (0151) — the management surface behind the Responsible and
 * Beneficiaries fields.
 *
 * It exists mainly for ONE job: reviewing the provisional entries ingest creates at
 * promote-time from calendar invites and mail headers. Those arrive `confirmed = 0`
 * with a name guessed from the address, so without a place to rename, merge, or delete
 * them the directory would slowly fill with near-duplicates ("A. Hartman" and "Alex
 * Hartman" from two sources) that nobody can tidy.
 *
 * The self row and account-linked rows are shown but not deletable — self anchors the
 * "me" shortcut, and an account row is re-materialized on the next pick anyway.
 */
export function PeopleSettings() {
  const [people, { refetch }] = createResource(async () => (await api.people.list()).people);
  const [newName, setNewName] = createSignal('');
  const [editing, setEditing] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal('');
  const [mergeFrom, setMergeFrom] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const rows = () => people() ?? [];
  const unconfirmed = () => rows().filter((p) => !p.confirmed);

  async function guard<T>(fn: () => Promise<T>): Promise<void> {
    setBusy(true);
    try { await fn(); await refetch(); }
    catch (err) { showToast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  const add = () => {
    const name = newName().trim();
    if (!name) return;
    void guard(async () => { await api.people.create({ display_name: name }); setNewName(''); });
  };

  const rename = (p: Person) => {
    const name = draft().trim();
    setEditing(null);
    if (!name || name === p.display_name) return;
    // Renaming a provisional entry IS the confirmation — the owner has looked at it.
    void guard(() => api.people.update(p.id, { display_name: name, confirmed: true }));
  };

  const label = (p: Person) =>
    p.is_self ? 'you' : p.account_id ? 'account' : p.emails[0] ?? '';

  return (
    <div class="flex flex-col gap-3">
      <Show when={unconfirmed().length > 0}>
        <p class="text-[11px] text-muted-foreground">
          {unconfirmed().length} detected automatically and not yet confirmed — rename, merge, or
          delete them here.
        </p>
      </Show>

      <div class="flex flex-col divide-y divide-border rounded-md border border-border">
        <For each={rows()} fallback={<p class="text-xs text-muted-foreground p-3">No people yet.</p>}>
          {(p) => (
            <div class="flex items-center gap-2 px-3 py-2">
              <div class="flex-1 min-w-0">
                <Show
                  when={editing() === p.id}
                  fallback={
                    <button
                      type="button"
                      onClick={() => { setEditing(p.id); setDraft(p.display_name); }}
                      class="text-sm text-foreground hover:text-primary transition-colors truncate text-left"
                      title="Rename"
                    >
                      {p.display_name}
                      <Show when={!p.confirmed}>
                        <span class="ml-1.5 text-[10px] text-muted-foreground">detected</span>
                      </Show>
                    </button>
                  }
                >
                  <input
                    class="w-full bg-transparent border border-border rounded px-1.5 py-0.5 text-sm outline-none focus:border-primary"
                    value={draft()}
                    autofocus
                    onInput={(e) => setDraft(e.currentTarget.value)}
                    onBlur={() => rename(p)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename(p);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                </Show>
                <Show when={label(p)}>
                  <div class="text-[10px] text-muted-foreground truncate">{label(p)}</div>
                </Show>
              </div>

              {/* Merge: pick a source, then a destination. Attachments and addresses
                  move; the duplicate goes. */}
              <Show
                when={mergeFrom() && mergeFrom() !== p.id}
                fallback={
                  <button
                    type="button"
                    disabled={busy() || p.is_self}
                    onClick={() => setMergeFrom(mergeFrom() === p.id ? null : p.id)}
                    class="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    title={mergeFrom() === p.id ? 'Cancel merge' : 'Merge this into another person'}
                  >
                    <Show when={mergeFrom() === p.id} fallback={<Merge size={13} />}>
                      <X size={13} />
                    </Show>
                  </button>
                }
              >
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => {
                    const from = mergeFrom()!;
                    setMergeFrom(null);
                    void guard(() => api.people.merge(p.id, from));
                  }}
                  class="text-xs text-primary hover:underline"
                  title="Merge the selected person into this one"
                >
                  <Check size={13} class="inline" /> merge here
                </button>
              </Show>

              <button
                type="button"
                disabled={busy() || p.is_self}
                onClick={() => void guard(() => api.people.delete(p.id))}
                class="text-muted-foreground hover:text-destructive disabled:opacity-30"
                title={p.is_self ? 'Your own row cannot be deleted' : 'Delete — also removes them from every item'}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </For>
      </div>

      <div class="flex items-center gap-1.5">
        <input
          class="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary"
          placeholder="Add a person…"
          value={newName()}
          onInput={(e) => setNewName(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <button type="button" disabled={busy() || !newName().trim()} onClick={add} class="btn-ghost text-xs px-2 py-1 disabled:opacity-40">
          <UserPlus size={12} /> Add
        </button>
      </div>
    </div>
  );
}
