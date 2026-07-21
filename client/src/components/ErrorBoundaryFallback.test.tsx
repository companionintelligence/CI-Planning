import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@solidjs/testing-library';
import { ErrorBoundary, createSignal } from 'solid-js';
import { ErrorBoundaryFallback } from './ErrorBoundaryFallback.js';

/**
 * The root ErrorBoundary's fallback: a thrown render degrades to a recoverable panel
 * instead of white-screening. Pins two things — the error message surfaces, and "Try
 * again" resets the boundary so a now-healthy child re-renders.
 */
describe('ErrorBoundaryFallback', () => {
  it('renders the error message instead of letting the throw escape', () => {
    const Boom = () => { throw new Error('kaboom-403'); };
    render(() => (
      <ErrorBoundary fallback={(err, reset) => <ErrorBoundaryFallback error={err} onReset={reset} />}>
        <Boom />
      </ErrorBoundary>
    ));
    expect(screen.getByText('This view hit an error')).toBeInTheDocument();
    expect(screen.getByText('kaboom-403')).toBeInTheDocument();
  });

  it('"Try again" resets the boundary and re-renders a now-healthy child', () => {
    const [fail, setFail] = createSignal(true);
    const Child = () => {
      if (fail()) throw new Error('transient');
      return <div>recovered-content</div>;
    };
    render(() => (
      <ErrorBoundary fallback={(err, reset) => (
        <ErrorBoundaryFallback error={err} onReset={() => { setFail(false); reset(); }} />
      )}>
        <Child />
      </ErrorBoundary>
    ));
    expect(screen.getByText('This view hit an error')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('recovered-content')).toBeInTheDocument();
  });

  it('falls back to a generic message for a non-Error throw', () => {
    const onReset = vi.fn();
    render(() => <ErrorBoundaryFallback error={{ weird: true }} onReset={onReset} />);
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  });
});
