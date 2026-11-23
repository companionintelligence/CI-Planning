import { createSignal, For, Show, onCleanup, onMount } from 'solid-js';
import { MessageCircle, Mic, Volume2, VolumeX, X } from 'lucide-solid';
import { ViewportOverlay } from './ViewportOverlay.js';
import { MicButton } from './MicButton.js';
import { api, type TaskAgentAction, type TaskAgentPlan, type TaskAgentScreenContext } from '../lib/api.js';
import { refetchObjectives, refetchTasks, setElementModal } from '../stores/index.js';
import { setActiveTask } from '../stores/selection.js';
import { revealDetails } from '../stores/ui.js';

type Message = { role: 'user' | 'assistant'; text: string };
type Result = { text: string; taskId?: string };

export function TaskAgent(props: { onClose: () => void; screenContext?: () => TaskAgentScreenContext }) {
  let panel!: HTMLElement;
  let messageInput!: HTMLTextAreaElement;
  let previousFocus: HTMLElement | null = null;
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [input, setInput] = createSignal('');
  const [plan, setPlan] = createSignal<TaskAgentPlan | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [voice, setVoice] = createSignal(false);
  const [results, setResults] = createSignal<Result[]>([]);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
  // iOS in-app browsers can expose webkitSpeechRecognition without delivering results.
  // Their keyboard dictation writes directly into the focused textarea instead.
  const ios = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  onMount(() => {
    previousFocus = document.activeElement as HTMLElement | null;
    panel.querySelector<HTMLElement>('button')?.focus();
  });
  onCleanup(() => {
    if (canSpeak) window.speechSynthesis.cancel();
    previousFocus?.focus();
  });
  const dialogKeys = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !busy()) { event.preventDefault(); props.onClose(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [href]')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const say = (text: string) => {
    if (!voice() || !canSpeak) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || 'en-US';
    window.speechSynthesis.speak(utterance);
  };
  const send = async () => {
    const text = input().trim();
    if (!text || busy() || plan()) return;
    const history = messages().slice(-6);
    setInput('');
    setMessages((previous) => [...previous, { role: 'user', text }]);
    setBusy(true);
    setError('');
    try {
      const result = await api.taskAgent.plan(text, history, props.screenContext?.());
      setMessages((previous) => [...previous, { role: 'assistant', text: result.reply }]);
      if (result.actions.length) setPlan(result);
      say(result.reply);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const taskName = (action: TaskAgentAction, current: TaskAgentPlan) =>
    'task_id' in action ? current.tasks.find((task) => task.id === action.task_id)?.title ?? 'Task' : action.title;
  const actionText = (action: TaskAgentAction, current: TaskAgentPlan) => {
    if (action.kind === 'create_task') return `Create “${action.title}”${action.scheduled_for ? ` for ${action.scheduled_for}` : ''}`;
    if (action.kind === 'add_note') return `Add note to “${taskName(action, current)}”: ${action.body}`;
    if (action.kind === 'draft_task') return `Fill unsaved fields for “${taskName(action, current)}” — ${Object.entries(action).filter(([key]) => !['kind', 'task_id'].includes(key)).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(', ')}`;
    if (action.kind === 'move_task') return `Move “${taskName(action, current)}” to ${current.objectives.find((objective) => objective.id === action.target_objective_id)?.title ?? 'objective'}`;
    const changes = Object.entries(action).filter(([key]) => !['kind', 'task_id'].includes(key)).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value ?? 'clear'}`);
    return `Update “${taskName(action, current)}” — ${changes.join(', ')}`;
  };
  const apply = async () => {
    const current = plan();
    if (!current || busy()) return;
    setBusy(true);
    setError('');
    let completed = 0;
    const saved: Result[] = [];
    const place = async (taskId: string) =>
      (await api.taskAgent.place(taskId).catch(() => ({ placement: { placed: false, reason: 'placement unavailable' } }))).placement;
    try {
      for (const action of current.actions) {
        if (action.kind === 'create_task') {
          const created = await api.tasks.create({ title: action.title, priority: action.priority, scheduled_for: action.scheduled_for, task_time: action.task_time, auto_place: !!action.scheduled_for });
          const placement = action.scheduled_for ? await place(created.task.id) : null;
          saved.push({ text: `${actionText(action, current)}${placement && !placement.placed ? ` (date saved; no calendar slot: ${placement.reason ?? 'unavailable'})` : ''}`, taskId: created.task.id });
        } else if (action.kind === 'add_note') {
          await api.taskAgent.addNote(action.task_id, action.body);
          saved.push({ text: actionText(action, current), taskId: action.task_id });
        } else if (action.kind === 'draft_task') {
          const { kind: _, task_id, ...agentDraft } = action;
          setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: task_id }, agentDraft });
          saved.push({ text: `Filled task form for review; save it when ready.`, taskId: task_id });
          props.onClose();
        } else if (action.kind === 'update_task') {
          const { kind: _, task_id, ...changes } = action;
          await api.tasks.update(task_id, changes);
          const placement = action.scheduled_for ? await place(task_id) : null;
          saved.push({ text: `${actionText(action, current)}${placement && !placement.placed ? ` (time saved; no calendar slot: ${placement.reason ?? 'unavailable'})` : ''}`, taskId: task_id });
        } else if (action.source_objective_id) {
          await api.objectives.moveTask(action.source_objective_id, action.task_id, action.target_objective_id);
          saved.push({ text: actionText(action, current), taskId: action.task_id });
        } else {
          await api.objectives.linkTask(action.target_objective_id, action.task_id);
          saved.push({ text: actionText(action, current), taskId: action.task_id });
        }
        completed++;
      }
      setPlan(null);
      setResults((previous) => [...previous, ...saved]);
      const summary = current.actions.some((action) => action.kind === 'draft_task') ? 'Draft fields are ready to review in the task form.' : `${completed} change${completed === 1 ? '' : 's'} saved.`;
      setMessages((previous) => [...previous, { role: 'assistant', text: summary }]);
      say(summary);
    } catch (err) {
      setPlan(null); // A retry must replan against current data after partial success.
      setResults((previous) => [...previous, ...saved]);
      setError(`${completed} of ${current.actions.length} changes saved. ${(err as Error).message}`);
    } finally {
      refetchTasks();
      refetchObjectives();
      setBusy(false);
    }
  };

  return <ViewportOverlay class="z-[100] bg-black/70 flex items-end md:items-center md:justify-end p-2 md:p-5" role="presentation">
    <section ref={panel} role="dialog" aria-modal="true" aria-label="Task assistant" onKeyDown={dialogKeys} class="card w-full md:w-[26rem] max-h-full md:max-h-[85vh] flex flex-col gap-3 overflow-hidden">
      <div class="flex items-center justify-between gap-2"><h2 class="font-semibold flex items-center gap-2"><MessageCircle size={18} /> Task assistant</h2><div class="flex items-center gap-1">
        <Show when={canSpeak}><button class="btn-icon" aria-label={voice() ? 'Mute replies' : 'Speak replies'} aria-pressed={voice()} onClick={() => { setVoice(!voice()); if (!voice()) window.speechSynthesis.cancel(); }}><Show when={voice()} fallback={<VolumeX size={17} />}><Volume2 size={17} /></Show></button></Show>
        <button class="btn-icon" aria-label="Close assistant" disabled={busy()} onClick={props.onClose}><X size={18} /></button>
      </div></div>
      <div class="flex-1 min-h-20 overflow-y-auto flex flex-col gap-2 text-sm" aria-live="polite">
        <Show when={!messages().length}><p class="text-muted-foreground">Ask me to create, edit, schedule, or move a task. I’ll show each change before saving it.</p></Show>
        <For each={messages()}>{(message) => <p class={message.role === 'user' ? 'self-end rounded-lg bg-primary/15 p-2 max-w-[90%]' : 'self-start rounded-lg bg-muted/40 p-2 max-w-[90%]'}>{message.text}</p>}</For>
        <For each={results()}>{(result) => <div class="rounded-lg border border-primary/40 p-2 flex items-center justify-between gap-2"><span>✓ {result.text}</span><Show when={result.taskId}><button class="btn-ghost text-xs" onClick={() => { setActiveTask(result.taskId!); revealDetails(); props.onClose(); }}>View</button></Show></div>}</For>
        <Show when={busy()}><p class="text-muted-foreground">Working…</p></Show>
      </div>
      <Show when={plan()}>{(current) => <div class="border border-border rounded-lg p-3 flex flex-col gap-2 text-sm">
        <strong>Review changes</strong>
        <For each={current().actions}>{(action) => <p>• {actionText(action, current())}</p>}</For>
        <p class="text-xs text-muted-foreground">Notes and task changes save when applied. Draft fields open in the task form and remain unsaved until you save there.</p>
        <div class="flex gap-2 justify-end"><button class="btn-ghost" disabled={busy()} onClick={() => setPlan(null)}>Dismiss</button><button class="btn-primary" disabled={busy()} onClick={() => void apply()}>Apply changes</button></div>
      </div>}</Show>
      <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
      <div class="flex items-end gap-2"><textarea ref={messageInput} class="input flex-1 min-w-0 min-h-12 max-h-32" aria-label="Message the task assistant" placeholder="What would you like done?" value={input()} disabled={!!plan() || busy()} onInput={(event) => setInput(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} /><Show when={ios} fallback={<MicButton title="Dictate your request" disabled={!!plan() || busy()} onTranscript={(text) => { setInput((value) => value ? `${value} ${text}` : text); setError(''); }} onError={setError} />}><button type="button" class="btn-icon" aria-label="Open keyboard for voice dictation" title="Use keyboard microphone" disabled={!!plan() || busy()} onClick={() => { messageInput.focus(); setError('Tap the microphone on your keyboard to dictate, then review your message and tap Send.'); }}><Mic size={17} /></button></Show><button class="btn-primary" disabled={!input().trim() || !!plan() || busy()} onClick={() => void send()}>Send</button></div>
      <p class="text-[11px] text-muted-foreground">{ios ? 'On iPhone, tap the mic above to open the keyboard, then use the keyboard microphone. Review the text here before Send.' : 'Tap the mic to dictate. Review the text here before Send. Your browser’s speech service may send audio to its provider.'}</p>
    </section>
  </ViewportOverlay>;
}
