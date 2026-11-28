import { createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-solid';
import { localISODate } from '../lib/dates.js';
import { ModalSheet } from './primitives.js';

type Props = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
  class?: string;
  triggerClass?: string;
  prefix?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: true;
  min?: string;
  max?: string;
  disabled?: boolean;
  clearable?: boolean;
  appearance?: 'field' | 'icon' | 'pill';
  presentation?: 'popover' | 'dialog';
  mode?: 'immediate' | 'confirm';
  confirmLabel?: string;
};

function parseDate(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(key: string, compact = false): string {
  const date = parseDate(key);
  if (!date) return '';
  return date.toLocaleDateString(undefined, compact ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

function accessibleDate(key: string): string {
  return parseDate(key)?.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) ?? '';
}

function withinBounds(key: string, min?: string, max?: string): boolean {
  return (!min || key >= min) && (!max || key <= max);
}

/** Canonical calendar control for every editable day in the app. */
export function DatePicker(props: Props) {
  const id = props.id ?? `date-picker-${createUniqueId()}`;
  const appearance = () => props.appearance ?? 'field';
  const presentation = () => props.presentation ?? 'popover';
  const mode = () => props.mode ?? (presentation() === 'dialog' ? 'confirm' : 'immediate');
  const [open, setOpen] = createSignal(false);
  const [month, setMonth] = createSignal(new Date(`${localISODate()}T12:00:00`));
  const [draft, setDraft] = createSignal(props.value);
  const [focusDate, setFocusDate] = createSignal(props.value || localISODate());
  let root: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;

  const initialDate = () => {
    const selected = props.value || localISODate();
    if (withinBounds(selected, props.min, props.max)) return selected;
    if (props.min && selected < props.min) return props.min;
    if (props.max && selected > props.max) return props.max;
    return selected;
  };
  const monthLabel = () => month().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const cells = () => {
    const cursor = month();
    const year = cursor.getFullYear();
    const monthIndex = cursor.getMonth();
    const offset = new Date(year, monthIndex, 1, 12).getDay();
    const count = new Date(year, monthIndex + 1, 0, 12).getDate();
    const dates = [...Array<string | null>(offset).fill(null), ...Array.from({ length: count }, (_, index) => dateKey(new Date(year, monthIndex, index + 1, 12)))];
    while (dates.length % 7) dates.push(null);
    return dates;
  };

  function openPicker() {
    const initial = initialDate();
    const date = parseDate(initial) ?? new Date(`${localISODate()}T12:00:00`);
    setDraft(props.value);
    setFocusDate(initial);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1, 12));
    setOpen(true);
  }
  function closePicker(commit = false, restoreFocus = false) {
    if (commit && mode() === 'confirm') props.onChange(draft());
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef?.focus());
  }
  function choose(key: string) {
    if (!withinBounds(key, props.min, props.max)) return;
    setDraft(key);
    setFocusDate(key);
    if (mode() === 'immediate') {
      props.onChange(key);
      setOpen(false);
      requestAnimationFrame(() => triggerRef?.focus());
    }
  }
  function setToday() {
    const today = localISODate();
    if (!withinBounds(today, props.min, props.max)) return;
    if (mode() === 'confirm') {
      setDraft(today);
      setFocusDate(today);
      setMonth(new Date(`${today}T12:00:00`));
    } else {
      props.onChange(today);
      setOpen(false);
      requestAnimationFrame(() => triggerRef?.focus());
    }
  }
  function canMoveMonth(amount: number): boolean {
    const target = new Date(month().getFullYear(), month().getMonth() + amount, 1, 12);
    const key = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
    return (!props.min || key >= props.min.slice(0, 7)) && (!props.max || key <= props.max.slice(0, 7));
  }
  function moveFocus(event: KeyboardEvent) {
    const current = parseDate((event.target as HTMLElement).dataset.date ?? '');
    if (!current) return;
    let next: Date | undefined;
    if (event.key === 'ArrowLeft') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1, 12);
    if (event.key === 'ArrowRight') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, 12);
    if (event.key === 'ArrowUp') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7, 12);
    if (event.key === 'ArrowDown') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7, 12);
    if (event.key === 'Home') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() - current.getDay(), 12);
    if (event.key === 'End') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 6 - current.getDay(), 12);
    if (event.key === 'PageUp') next = new Date(current.getFullYear(), current.getMonth() - (event.shiftKey ? 12 : 1), current.getDate(), 12);
    if (event.key === 'PageDown') next = new Date(current.getFullYear(), current.getMonth() + (event.shiftKey ? 12 : 1), current.getDate(), 12);
    if (!next) return;
    const key = dateKey(next);
    if (!withinBounds(key, props.min, props.max)) return;
    event.preventDefault();
    setFocusDate(key);
    if (next.getMonth() !== month().getMonth() || next.getFullYear() !== month().getFullYear()) setMonth(new Date(next.getFullYear(), next.getMonth(), 1, 12));
    requestAnimationFrame(() => document.getElementById(`${id}-day-${key}`)?.focus());
  }

  const monthControls = (dialog = false) => (
    <div class={`ui-date-picker__monthbar ${dialog ? 'ui-date-picker__monthbar--dialog' : ''}`}>
      <button type="button" class="btn-icon" aria-label="Previous month" disabled={!canMoveMonth(-1)} onClick={() => setMonth(new Date(month().getFullYear(), month().getMonth() - 1, 1, 12))}><ChevronLeft size={16} /></button>
      <h2 class="ui-date-picker__month" aria-live="polite">{monthLabel()}</h2>
      <button type="button" class="btn-icon" aria-label="Next month" disabled={!canMoveMonth(1)} onClick={() => setMonth(new Date(month().getFullYear(), month().getMonth() + 1, 1, 12))}><ChevronRight size={16} /></button>
      <Show when={dialog}><button type="button" class="btn-icon" aria-label="Close calendar" onClick={() => closePicker()}><X size={16} /></button></Show>
    </div>
  );
  const calendarGrid = () => (
    <div class="ui-date-picker__grid" role="grid" aria-label={monthLabel()} onKeyDown={moveFocus}>
      <For each={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']}>{(weekday) => <span class="ui-date-picker__weekday" role="columnheader">{weekday}</span>}</For>
      <For each={cells()}>{(key) => key === null
        ? <span role="presentation" aria-hidden="true" />
        : <button
            id={`${id}-day-${key}`} type="button" role="gridcell" data-date={key} class="ui-date-picker__day"
            classList={{ 'is-selected': (mode() === 'confirm' ? draft() : props.value) === key, 'is-today': key === localISODate() }}
            aria-label={accessibleDate(key)} aria-selected={(mode() === 'confirm' ? draft() : props.value) === key}
            tabindex={focusDate() === key ? 0 : -1} disabled={!withinBounds(key, props.min, props.max)}
            onFocus={() => setFocusDate(key)} onClick={() => choose(key)}
          >{Number(key.slice(8, 10))}</button>}
      </For>
    </div>
  );
  const footer = (dialog = false) => (
    <div class={`ui-date-picker__footer ${dialog ? 'ui-date-picker__dialog-footer' : ''}`}>
      <button type="button" class="btn-ghost text-xs" disabled={!withinBounds(localISODate(), props.min, props.max)} onClick={setToday}>Today</button>
      <Show when={props.clearable}><button type="button" class="btn-ghost text-xs" onClick={() => { setDraft(''); if (mode() === 'immediate') { props.onChange(''); closePicker(false, true); } }}>Clear</button></Show>
      <Show when={mode() === 'confirm'}>
        <div class="flex gap-2">
          <button type="button" class="btn-ghost text-xs" onClick={() => closePicker(false, true)}>Cancel</button>
          <button type="button" class="btn-primary text-xs" onClick={() => closePicker(true, true)}>{props.confirmLabel ?? 'Choose date'}</button>
        </div>
      </Show>
      <Show when={mode() === 'immediate'}><button type="button" class="btn-ghost text-xs" onClick={() => closePicker(false, true)}>Done</button></Show>
    </div>
  );

  // The anchored field popover closes on outside click; the modal version delegates
  // Escape, focus trapping and focus restoration to ModalSheet.
  const closeOnOutside = (event: PointerEvent) => {
    if (open() && presentation() === 'popover' && root && !root.contains(event.target as Node)) closePicker(mode() === 'confirm');
  };
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open() && presentation() === 'popover') {
      event.stopPropagation();
      closePicker(false, true);
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    onCleanup(() => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    });
  }

  return (
    <div ref={root} class={`ui-date-picker ${appearance() === 'pill' ? 'ui-date-picker--pill' : ''} ${props.class ?? ''}`}>
      <button
        ref={triggerRef}
        id={id} type="button"
        class={appearance() === 'icon' ? `btn-icon ui-date-picker__icon-trigger ${props.triggerClass ?? ''}` : appearance() === 'pill' ? `ui-date-picker__pill-trigger ${props.triggerClass ?? ''}` : `input ui-date-picker__trigger ${props.triggerClass ?? ''}`}
        aria-label={`${props.label}${props.value ? `: ${formatDate(props.value)}` : ''}`} aria-describedby={props['aria-describedby']} aria-invalid={props['aria-invalid']} aria-required={props.required}
        aria-haspopup="dialog" aria-expanded={open()} aria-controls={`${id}-popup`} disabled={props.disabled} onClick={() => open() ? closePicker(false, true) : openPicker()}
      >
        <Show when={appearance() === 'icon'}><CalendarDays size={16} aria-hidden="true" /></Show>
        <Show when={appearance() !== 'icon'}>
          <Show when={appearance() === 'pill' && props.prefix}><span class="ui-date-picker__prefix">{props.prefix} </span></Show>
          <span>{props.value ? formatDate(props.value, appearance() === 'pill') : appearance() === 'pill' ? '—' : 'Choose date'}</span>
          <CalendarDays size={appearance() === 'pill' ? 12 : 16} aria-hidden="true" />
        </Show>
      </button>
      <Show when={props.clearable && props.value}>
        <button type="button" class={appearance() === 'pill' ? 'ui-date-picker__pill-clear' : 'ui-date-picker__clear'} aria-label={`Clear ${props.label.toLowerCase()}`} onClick={() => props.onChange('')}><X size={appearance() === 'pill' ? 11 : 13} /></button>
      </Show>
      <Show when={presentation() === 'popover' && open()}>
        <div id={`${id}-popup`} class="ui-date-picker__popover" role="dialog" aria-label={props.label}>
          {monthControls()}
          {calendarGrid()}
          {footer()}
        </div>
      </Show>
      <Show when={presentation() === 'dialog' && open()}>
        <ModalSheet open title={props.label} ariaLabel={props.label} onClose={() => closePicker()} class="max-w-sm rounded-2xl"
          header={<header class="ui-date-picker__dialog-header">{monthControls(true)}</header>}
          footer={footer(true)}>
          <div class="px-4">{calendarGrid()}</div>
        </ModalSheet>
      </Show>
    </div>
  );
}
