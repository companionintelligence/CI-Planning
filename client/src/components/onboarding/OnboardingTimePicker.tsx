import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Clock3 } from 'lucide-solid';

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

type Period = 'AM' | 'PM';

function readTime(value: string): { hour: number; minute: number; period: Period } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  const minutes = match ? (Number(match[1]) * 60 + Number(match[2])) % 1440 : 7 * 60;
  const hour24 = Math.floor(minutes / 60);
  return {
    hour: hour24 % 12 || 12,
    minute: minutes % 60,
    period: hour24 < 12 ? 'AM' : 'PM',
  };
}

function writeTime(hour: number, minute: number, period: Period) {
  const hour24 = (hour % 12) + (period === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function displayTime(value: string) {
  const time = readTime(value);
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')} ${time.period}`;
}

/** A themed, keyboard-operable time popover for the FTUE (native picker popups cannot be styled). */
export function OnboardingTimePicker(props: Props) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  function closeOnOutside(event: PointerEvent) {
    if (root && !root.contains(event.target as Node)) setOpen(false);
  }

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key === 'Escape' && open()) {
      event.stopPropagation();
      setOpen(false);
    }
  }

  onMount(() => {
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
  });
  onCleanup(() => {
    document.removeEventListener('pointerdown', closeOnOutside);
    document.removeEventListener('keydown', closeOnEscape);
  });

  const updateNumber = (field: 'hour' | 'minute', value: string) => {
    const current = readTime(props.value);
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const bounded = field === 'hour'
      ? Math.min(12, Math.max(1, parsed))
      : Math.min(59, Math.max(0, parsed));
    props.onChange(writeTime(
      field === 'hour' ? bounded : current.hour,
      field === 'minute' ? bounded : current.minute,
      current.period,
    ));
  };

  return (
    <div class="ftue-time-picker" ref={root}>
      <button
        type="button"
        class="input ftue-time-picker__trigger"
        aria-label={`${props.label}: ${displayTime(props.value)}`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={`${props.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-time-popover`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{displayTime(props.value)}</span>
        <Clock3 size={16} aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div
          id={`${props.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-time-popover`}
          class="ftue-time-picker__popover"
          role="dialog"
          aria-label={`Set ${props.label.toLowerCase()}`}
        >
          <div class="ftue-time-picker__controls">
            <label class="ftue-time-picker__number-field">
              <span class="ftue-time-picker__caption">Hour</span>
              <input class="input" type="number" min="1" max="12" inputMode="numeric" value={readTime(props.value).hour} onInput={(event) => updateNumber('hour', event.currentTarget.value)} />
            </label>
            <label class="ftue-time-picker__number-field">
              <span class="ftue-time-picker__caption">Minute</span>
              <input class="input" type="number" min="0" max="59" inputMode="numeric" value={readTime(props.value).minute} onInput={(event) => updateNumber('minute', event.currentTarget.value)} />
            </label>
            <div class="ftue-time-picker__column">
              <span class="ftue-time-picker__caption">Period</span>
              <div class="ftue-time-picker__period" role="group" aria-label="AM or PM">
                <button type="button" aria-pressed={readTime(props.value).period === 'AM'} onClick={() => props.onChange(writeTime(readTime(props.value).hour, readTime(props.value).minute, 'AM'))}>AM</button>
                <button type="button" aria-pressed={readTime(props.value).period === 'PM'} onClick={() => props.onChange(writeTime(readTime(props.value).hour, readTime(props.value).minute, 'PM'))}>PM</button>
              </div>
            </div>
          </div>
          <div class="ftue-time-picker__footer">
            <span>{displayTime(props.value)}</span>
            <button type="button" class="btn-primary text-xs" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      </Show>
    </div>
  );
}
