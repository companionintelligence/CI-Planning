import { createSignal, onCleanup, Show } from 'solid-js';
import { Mic } from 'lucide-solid';
import { createSpeechCapture, speechSupported } from '../lib/speech.js';

/**
 * T14 (#350) — the mic affordance shared by the NL input surfaces (ElementWizard's
 * quick line, InstructBox). Renders NOTHING when the browser has no
 * SpeechRecognition (typing is the degrade path — no dead button, no error).
 * One tap starts a one-shot capture; the transcript is handed to the host input
 * via `onTranscript` — voice is sugar over the exact same text path. A tap while
 * listening aborts. Errors (denied mic, silence) surface through `onError`.
 */
export function MicButton(props: {
  onTranscript: (text: string) => void;
  onError?: (reason: string) => void;
  disabled?: boolean;
  class?: string;
  title?: string;
}) {
  const [listening, setListening] = createSignal(false);

  const capture = createSpeechCapture({
    onTranscript: (text) => props.onTranscript(text),
    onError: (reason) => props.onError?.(reason),
    onDone: () => setListening(false),
  });
  onCleanup(() => capture.stop());

  const toggle = () => {
    if (props.disabled) return;
    if (listening()) {
      capture.stop();
      setListening(false);
    } else {
      setListening(true);
      capture.start();
    }
  };

  return (
    <Show when={speechSupported()}>
      <button
        type="button"
        onClick={toggle}
        disabled={props.disabled}
        title={props.title ?? (listening() ? 'Stop listening' : 'Speak instead of typing')}
        aria-pressed={listening()}
        class={props.class ?? 'btn-icon'}
        classList={{ 'text-destructive animate-pulse2': listening() }}
      >
        <Mic size={14} />
      </button>
    </Show>
  );
}
