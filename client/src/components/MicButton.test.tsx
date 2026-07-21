import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import { MicButton } from './MicButton.js';

/**
 * T14 (#350) — the mic affordance's fallback matrix (the ticket's AC):
 *   - no SpeechRecognition → NO button renders (typing untouched, nothing errors);
 *   - supported → tap starts a capture, transcript reaches onTranscript;
 *   - a recognition error reaches onError and the listening state clears.
 */

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  interimResults = true;
  maxAlternatives = 0;
  onresult: ((e: { results: { transcript: string }[][] }) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start() { FakeRecognition.last = this; }
  stop() {}
  abort() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.last = null;
});

describe('MicButton', () => {
  it('renders NOTHING when the browser has no SpeechRecognition (jsdom default)', () => {
    const { container } = render(() => <MicButton onTranscript={vi.fn()} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('captures a tap → transcript → onTranscript', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const onTranscript = vi.fn();
    const { container } = render(() => <MicButton onTranscript={onTranscript} />);
    const btn = container.querySelector('button')!;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true'); // listening
    FakeRecognition.last!.onresult!({ results: [[{ transcript: 'buy milk tomorrow' }]] });
    FakeRecognition.last!.onend!();
    expect(onTranscript).toHaveBeenCalledWith('buy milk tomorrow');
    expect(btn.getAttribute('aria-pressed')).toBe('false'); // cleared on end
  });

  it('surfaces a denied mic via onError and clears listening', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const onError = vi.fn();
    const { container } = render(() => <MicButton onTranscript={vi.fn()} onError={onError} />);
    const btn = container.querySelector('button')!;
    fireEvent.click(btn);
    FakeRecognition.last!.onerror!({ error: 'not-allowed' });
    FakeRecognition.last!.onend!();
    expect(onError).toHaveBeenCalledWith('Microphone permission denied');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
});
