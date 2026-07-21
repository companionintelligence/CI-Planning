/**
 * T14 (#350) — browser speech capture for the NL input surfaces (ElementWizard's
 * quick line, InstructBox). Web Speech API ONLY (SpeechRecognition /
 * webkitSpeechRecognition): transcription happens locally in the browser engine —
 * no cloud STT, per the local-first invariant. Voice is sugar over the existing
 * text path: a transcript lands in the same input the user could have typed into.
 *
 * Degrades cleanly: `speechSupported()` is false where the API is absent (Firefox,
 * some WebViews) and callers simply don't render a mic; a denied mic permission or
 * recognition error surfaces via `onError` and never breaks typing.
 */

// Minimal structural typings — lib.dom omits the (still-prefixed) API.
interface SpeechRecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechRecognitionErrorEventLike {
  error?: string;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when the browser exposes a speech-recognition engine. */
export function speechSupported(): boolean {
  return recognitionCtor() !== null;
}

export interface SpeechCapture {
  /** Begin one-shot capture. No-op while already listening or unsupported. */
  start(): void;
  /** Abort a capture in flight (no transcript fires). */
  stop(): void;
}

/**
 * One-shot capture: start() listens for a single utterance, fires
 * `onTranscript(text)` with the top alternative, then ends (onDone fires on every
 * end — success, error, or silence — so callers can clear a "listening" flag).
 * Errors (denied mic, no speech, engine failure) go to `onError` with a short
 * human-readable reason; the caller decides how to surface it.
 */
export function createSpeechCapture(handlers: {
  onTranscript: (text: string) => void;
  onError?: (reason: string) => void;
  onDone?: () => void;
}): SpeechCapture {
  const Ctor = recognitionCtor();
  let active: SpeechRecognitionLike | null = null;

  return {
    start() {
      if (!Ctor || active) return;
      const rec = new Ctor();
      active = rec;
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const transcript = Array.from({ length: e.results.length }, (_, i) => e.results[i][0].transcript)
          .join(' ')
          .trim();
        if (transcript) handlers.onTranscript(transcript);
      };
      rec.onerror = (e) => {
        const reason =
          e.error === 'not-allowed' || e.error === 'service-not-allowed'
            ? 'Microphone permission denied'
            : e.error === 'no-speech'
              ? 'No speech detected'
              : `Speech capture failed${e.error ? ` (${e.error})` : ''}`;
        handlers.onError?.(reason);
      };
      rec.onend = () => {
        active = null;
        handlers.onDone?.();
      };
      try {
        rec.start();
      } catch {
        // start() throws if called while another capture runs — treat as a no-op.
        active = null;
        handlers.onDone?.();
      }
    },
    stop() {
      active?.abort();
      active = null;
    },
  };
}
