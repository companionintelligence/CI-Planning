import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { Pencil, RefreshCw, Share2, Trash2, X } from 'lucide-solid';
import { api, type SharedPlannerItem } from '../lib/api.js';
import { showToast } from '../stores/index.js';

const keyOf = (item: SharedPlannerItem) => `${item.entity_kind}:${item.entity_id}`;
const flatten = <T extends { children?: T[] }>(rows: T[]): T[] => rows.flatMap((row) => [row, ...flatten(row.children ?? [])]);

/** Invite people to selected canonical tasks/objectives and edit those grants later. */
export function SharedAccessSettings() {
  const [invites, { refetch }] = createResource(async () => (await api.people.shares.list()).invites);
  const [me] = createResource(() => api.auth.me());
  const [tasks] = createResource(() => me()?.ownerId ?? null, async (ownerId) => ownerId
    ? (await api.tasks.list()).tasks.filter((task) => task.owner_id === ownerId && !task.shared && task.status !== 'cancelled')
    : []);
  const [objectives] = createResource(async () => flatten((await api.objectives.list()).objectives));
  const [email, setEmail] = createSignal('');
  const [selected, setSelected] = createSignal<string[]>([]);
  const [editId, setEditId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [inviteLink, setInviteLink] = createSignal<string | null>(null);
  const choices = createMemo(() => [
    ...(tasks() ?? []).map((task) => ({ entity_kind: 'task' as const, entity_id: task.id, title: task.title })),
    ...(objectives() ?? []).map((objective) => ({ entity_kind: 'objective' as const, entity_id: objective.id, title: objective.title })),
  ]);

  const choose = (key: string) => setSelected((prev) => prev.includes(key) ? prev.filter((v) => v !== key) : [...prev, key]);
  const beginEdit = (inviteId: string) => {
    const invite = (invites() ?? []).find((item) => item.id === inviteId);
    if (!invite) return;
    setEditId(inviteId);
    setEmail(invite.email);
    setSelected(invite.items.map(keyOf));
  };
  const reset = () => { setEditId(null); setEmail(''); setSelected([]); };
  const save = async () => {
    const isEditing = !!editId();
    const items = choices().filter((item) => selected().includes(keyOf(item))).map(({ entity_kind, entity_id }) => ({ entity_kind, entity_id }));
    if (!email().trim() || items.length === 0) { showToast('Add an email and choose at least one item', 'error'); return; }
    setBusy(true);
    try {
      const result = editId()
        ? await api.people.shares.update(editId()!, items)
        : await api.people.shares.create(email().trim(), items);
      if ('invite_link' in result && typeof result.invite_link === 'string') setInviteLink(result.invite_link);
      await refetch();
      reset();
      showToast(isEditing ? 'Shared access updated' : 'Invitation sent', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const resend = async (id: string) => {
    try {
      const result = await api.people.shares.resend(id);
      if (result.invite_link) setInviteLink(result.invite_link);
      showToast(result.delivery === 'link' ? 'Copy the sign-in link below' : 'Invitation sent again', 'success');
    }
    catch (err) { showToast((err as Error).message, 'error'); }
  };
  const revoke = async (id: string) => {
    if (!confirm('Remove this person’s access to the shared items?')) return;
    try { await api.people.shares.revoke(id); await refetch(); showToast('Shared access removed', 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  };

  return (
    <section class="card flex flex-col gap-3" aria-labelledby="shared-access-title">
      <div>
        <div id="shared-access-title" class="section-label flex items-center gap-1.5"><Share2 size={12} /> Shared tasks and objectives</div>
        <p class="text-xs text-muted-foreground mt-1">Changes to shared tasks update the original task.</p>
      </div>
      <Show when={invites.error}>
        <div class="text-xs text-destructive" role="alert">Shared access could not load.</div>
      </Show>
      <Show when={(invites() ?? []).length === 0 && !invites.loading}>
        <p class="text-xs text-muted-foreground">No shared items yet.</p>
      </Show>
      <div class="flex flex-col gap-2">
        <For each={invites() ?? []}>{(invite) => (
          <div class="rounded-md border border-border p-2.5 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <div class="min-w-0">
                <div class="text-sm text-foreground break-all">{invite.email}</div>
                <div class="text-[11px] text-muted-foreground">
                  {invite.recipient_name ? `${invite.recipient_name} · ` : ''}{invite.status} · {invite.items.length} item{invite.items.length === 1 ? '' : 's'}
                </div>
              </div>
              <Show when={invite.status !== 'revoked'} fallback={<span class="text-[11px] text-muted-foreground">Access revoked</span>}>
                <div class="flex items-center gap-1">
                  <button type="button" class="btn-ghost text-xs px-2 py-1" onClick={() => beginEdit(invite.id)}><Pencil size={12} /> Edit</button>
                  <button type="button" class="btn-ghost text-xs px-2 py-1" onClick={() => void resend(invite.id)} title="Send the invitation again"><RefreshCw size={12} /> Resend</button>
                  <button type="button" class="btn-ghost text-xs px-2 py-1 text-destructive" onClick={() => void revoke(invite.id)} title="Remove access"><Trash2 size={12} /></button>
                </div>
              </Show>
            </div>
            <div class="flex flex-wrap gap-1">
              <For each={invite.items}>{(item) => <span class="badge-neutral text-[10px]">{item.entity_kind}: {item.title}</span>}</For>
            </div>
          </div>
        )}</For>
      </div>

      <div class="border-t border-border pt-3 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-foreground">{editId() ? 'Edit shared access' : 'Invite someone'}</span>
          <Show when={editId()}><button type="button" class="btn-ghost px-2 py-1" aria-label="Cancel editing" onClick={reset}><X size={13} /></button></Show>
        </div>
        <label class="text-[11px] text-muted-foreground">Email address
          <input class="input mt-1 w-full text-sm" type="email" autocomplete="email" placeholder="name@example.com" value={email()} disabled={!!editId()} onInput={(e) => setEmail(e.currentTarget.value)} />
        </label>
        <div class="max-h-56 overflow-auto rounded-md border border-border divide-y divide-border">
          <Show when={choices().length > 0} fallback={<div class="p-3 text-xs text-muted-foreground">Add tasks or objectives before sharing.</div>}>
            <For each={choices()}>{(item) => {
              const key = keyOf(item);
              return <label class="flex items-center gap-2 px-2.5 py-2 text-xs cursor-pointer hover:bg-muted/40">
                <input type="checkbox" checked={selected().includes(key)} onChange={() => choose(key)} />
                <span class="text-muted-foreground capitalize">{item.entity_kind}</span>
                <span class="min-w-0 truncate text-foreground">{item.title}</span>
              </label>;
            }}</For>
          </Show>
        </div>
        <div class="flex justify-end">
          <button type="button" class="btn-primary text-xs px-3 py-1.5" disabled={busy() || tasks.loading || objectives.loading || !email().trim() || selected().length === 0} onClick={() => void save()}>
            {busy() ? 'Saving…' : editId() ? 'Save access' : 'Send invite'}
          </button>
        </div>
      </div>
      <Show when={inviteLink()}>
        {(link) => <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 flex flex-col gap-1">
          <div class="flex items-center justify-between gap-2"><span class="text-xs text-foreground">Copy this sign-in link to the invitee.</span>
            <button type="button" class="btn-ghost px-2 py-1" aria-label="Hide sign-in link" onClick={() => setInviteLink(null)}><X size={12} /></button></div>
          <code class="text-[11px] break-all select-all">{link()}</code>
        </div>}
      </Show>
    </section>
  );
}
