import { createSignal, createUniqueId, onCleanup, onMount, Show } from 'solid-js';
import { Clock3 } from 'lucide-solid';

type Props = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
  class?: string;
  triggerClass?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: true;
  disabled?: boolean;
  stepMinutes?: number;
  min?: string;
  max?: string;
  clearable?: boolean;
  align?: 'start' | 'end';
  onCommit?: () => void;
  onEnter?: () => void;
};

type Period = 'AM' | 'PM';
type ClockValue = { hour: number; minute: number; period: Period };

function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').slice(0, 5));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function toClock(value: string): ClockValue {
  const minutes = parseMinutes(value) ?? 9 * 60;
  const hour24 = Math.floor(minutes / 60);
  return { hour: hour24 % 12 || 12, minute: minutes % 60, period: hour24 < 12 ? 'AM' : 'PM' };
}

function fromClock(clock: ClockValue): string {
  const hour24 = clock.hour % 12 + (clock.period === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
}

function displayTime(value: string): string {
  const minutes = parseMinutes(value);
  if (minutes === null) return '';
  const clock = toClock(value);
  return `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')} ${clock.period}`;
}

function boundedTime(value: string, min?: string, max?: string, step = 1): string {
  let minutes = parseMinutes(value) ?? parseMinutes(min ?? '') ?? 9 * 60;
  const minimum = parseMinutes(min ?? '');
  const maximum = parseMinutes(max ?? '');
  minutes = Math.round(minutes / Math.max(1, step)) * Math.max(1, step);
  if (minimum !== null) minutes = Math.max(minutes, minimum);
  if (maximum !== null) minutes = Math.min(minutes, maximum);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The canonical themed time control. Values stay in 24-hour HH:mm form at the API edge. */
export function TimePicker(props: Props) {
  const id = props.id ?? `time-picker-${createUniqueId()}`;
  const step = () => Math.max(1, props.stepMinutes ?? 1);
  const [open, setOpen] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  let root: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;

  function openPicker() {
    const initial = props.value || props.min || '09:00';
    setDraft(boundedTime(initial, props.min, props.max, step()));
    setOpen(true);
  }
  function setClock(next: ClockValue) {
    const normalized = boundedTime(fromClock(next), props.min, props.max, step());
    setDraft(normalized);
    props.onChange(normalized);
  }
  function updateNumber(field: 'hour' | 'minute', value: string) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const current = toClock(draft());
    const bounded = field === 'hour' ? Math.min(12, Math.max(1, parsed)) : Math.min(59, Math.max(0, parsed));
    setClock({ ...current, [field]: bounded });
  }
  function close(commit = true, restoreFocus = false) {
    if (commit) props.onCommit?.();
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef?.focus());
  }
  function clear() {
    props.onChange('');
    props.onCommit?.();
    setOpen(false);
  }
  function outside(event: PointerEvent) {
    if (open() && root && !root.contains(event.target as Node)) close();
  }
  function escape(event: KeyboardEvent) {
    if (open() && event.key === 'Escape') {
      event.stopPropagation();
      close(true, true);
    }
  }
  onMount(() => {
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
  });
  onCleanup(() => {
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape);
  });

  const clock = () => toClock(draft() || props.value || props.min || '09:00');
  const renderedTime = () => displayTime(props.value);
  return (
    <div ref={root} class={`ui-time-picker ${props.align === 'start' ? 'ui-time-picker--start' : ''} ${props.class ?? ''}`}>
      <button
        ref={triggerRef} id={id} type="button" class={`input ui-time-picker__trigger ${props.triggerClass ?? ''}`}
        aria-label={`${props.label}${renderedTime() ? `: ${renderedTime()}` : ''}`} aria-describedby={props['aria-describedby']} aria-invalid={props['aria-invalid']} aria-required={props.required}
        aria-haspopup="dialog" aria-expanded={open()} aria-controls={`${id}-popup`} disabled={props.disabled}
        onKeyDown={(event) => { if (event.key === 'Enter' && props.onEnter) { event.preventDefault(); props.onEnter(); } }}
        onClick={() => open() ? close(true, true) : openPicker()}
      >
        <span>{renderedTime() || 'Choose time'}</span>
        <Clock3 size={16} aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div id={`${id}-popup`} class="ui-time-picker__popover" role="dialog" aria-label={`Set ${props.label.toLowerCase()}`}>
          <div class="ui-time-picker__controls">
            <label class="ui-time-picker__number-field">
              <span class="ui-time-picker__caption">Hour</span>
              <input class="input" type="number" min="1" max="12" step="1" inputMode="numeric" value={clock().hour} autofocus onInput={(event) => updateNumber('hour', event.currentTarget.value)} />
            </label>
            <label class="ui-time-picker__number-field">
              <span class="ui-time-picker__caption">Minute</span>
              <input class="input" type="number" min="0" max="59" step={step()} inputMode="numeric" value={clock().minute} onInput={(event) => updateNumber('minute', event.currentTarget.value)} />
            </label>
            <div class="ui-time-picker__column">
              <span class="ui-time-picker__caption">Period</span>
              <div class="ui-time-picker__period" role="group" aria-label="AM or PM">
                <button type="button" aria-pressed={clock().period === 'AM'} onClick={() => setClock({ ...clock(), period: 'AM' })}>AM</button>
                <button type="button" aria-pressed={clock().period === 'PM'} onClick={() => setClock({ ...clock(), period: 'PM' })}>PM</button>
              </div>
            </div>
          </div>
          <div class="ui-time-picker__footer">
            <Show when={props.clearable}><button type="button" class="btn-ghost text-xs" onClick={clear}>Clear</button><span>{displayTime(draft())}</span></Show>
            <Show when={!props.clearable}><span>{displayTime(draft())}</span></Show>
            <button type="button" class="btn-primary text-xs" onClick={() => close(true, true)}>Done</button>
          </div>
        </div>
      </Show>
    </div>
  );
}
