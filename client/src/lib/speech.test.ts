import { describe, it, expect, vi, afterEach } from 'vitest';
import { speechSupported, createSpeechCapture } from './speech.js';

/**
 * T14 (#350) — the speech helper's contract: feature-detect (jsdom has no
 * SpeechRecognition → unsupported), one-shot transcript delivery, error mapping
 * (denied mic / silence), and onDone firing on every end so hosts can clear a
 * listening flag. No cloud STT anywhere — the API IS the engine.
 */

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  interimResults = true;
  maxAlternatives = 0;
  onresult: ((e: { results: { transcript: string }[][] }) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;
  start() { this.started = true; FakeRecognition.instances.push(this); }
  stop() {}
  abort() { this.aborted = true; }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.instances = [];
});

describe('speechSupported', () => {
  it('is false in a browser without SpeechRecognition (jsdom)', () => {
    expect(speechSupported()).toBe(false);
  });

  it('is true when the (webkit-prefixed) API exists', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    expect(speechSupported()).toBe(true);
  });
});

describe('createSpeechCapture', () => {
  it('start() is a safe no-op when unsupported — typing is the degrade path', () => {
    const onTranscript = vi.fn();
    const capture = createSpeechCapture({ onTranscript });
    expect(() => capture.start()).not.toThrow();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('delivers the transcript, then onDone on end', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const onTranscript = vi.fn();
    const onDone = vi.fn();
    const capture = createSpeechCapture({ onTranscript, onDone });
    capture.start();
    const rec = FakeRecognition.instances[0];
    expect(rec.started).toBe(true);
    expect(rec.interimResults).toBe(false); // one-shot: finals only
    rec.onresult!({ results: [[{ transcript: 'pay invoice friday 3pm' }]] });
    rec.onend!();
    expect(onTranscript).toHaveBeenCalledWith('pay invoice friday 3pm');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('maps a denied mic to a human-readable reason and still ends', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const onError = vi.fn();
    const onDone = vi.fn();
    const capture = createSpeechCapture({ onTranscript: vi.fn(), onError, onDone });
    capture.start();
    const rec = FakeRecognition.instances[0];
    rec.onerror!({ error: 'not-allowed' });
    rec.onend!();
    expect(onError).toHaveBeenCalledWith('Microphone permission denied');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('maps silence to "No speech detected"', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const onError = vi.fn();
    const capture = createSpeechCapture({ onTranscript: vi.fn(), onError });
    capture.start();
    FakeRecognition.instances[0].onerror!({ error: 'no-speech' });
    expect(onError).toHaveBeenCalledWith('No speech detected');
  });

  it('stop() aborts an in-flight capture (no transcript fires)', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const onTranscript = vi.fn();
    const capture = createSpeechCapture({ onTranscript });
    capture.start();
    capture.stop();
    expect(FakeRecognition.instances[0].aborted).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
