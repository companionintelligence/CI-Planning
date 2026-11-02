import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import type { Integrations, MemoryStatus } from '../../lib/api.js';

const memoryStatusMock = vi.fn();
const integrationsMock = vi.fn();

vi.mock('../../lib/api.js', () => ({
  api: { memory: { status: () => memoryStatusMock() } },
}));
vi.mock('../../stores/index.js', () => ({
  integrations: () => integrationsMock(),
}));

import { MemoryAndAiPanel } from './MemoryAndAiPanel.js';

function memoryStatus(overrides: Partial<MemoryStatus> = {}): MemoryStatus {
  return {
    enabled: true,
    connected: false,
    account: null,
    lastSyncedAt: null,
    available: true,
    scopes: { completed: true, habits: true, reflections: true },
    pull: { enabled: false, available: false, source: null, authKind: null, host: null },
    ...overrides,
  };
}

function ollamaReady(ready: boolean): Integrations {
  return {
    ollama: { available: ready, ready, models: [], fastModel: '', qualityModel: '', embedModel: '' },
  } as unknown as Integrations;
}

describe('MemoryAndAiPanel (FTUE connect step)', () => {
  beforeEach(() => {
    memoryStatusMock.mockReset();
    integrationsMock.mockReset();
  });

  it('shows Companion Memory as connected, with the account, and AI as ready', async () => {
    memoryStatusMock.mockResolvedValue(memoryStatus({ connected: true, account: 'memory.example.com' }));
    integrationsMock.mockReturnValue(ollamaReady(true));
    render(() => <MemoryAndAiPanel />);
    expect(await screen.findByText('Companion Memory is connected as memory.example.com.')).toBeTruthy();
    expect(screen.getByText('AI is ready on this server.')).toBeTruthy();
  });

  it('names the address the server is configured with when the owner has not connected yet', async () => {
    memoryStatusMock.mockResolvedValue(
      memoryStatus({ pull: { enabled: true, available: true, source: 'env', authKind: null, host: 'memory.example.com' } }),
    );
    integrationsMock.mockReturnValue(ollamaReady(false));
    render(() => <MemoryAndAiPanel />);
    expect(await screen.findByText('This server is configured for Companion Memory at memory.example.com.')).toBeTruthy();
    expect(screen.getByText(/No AI model is ready yet/)).toBeTruthy();
  });

  it("says Companion Memory isn't connected when nothing is configured", async () => {
    memoryStatusMock.mockResolvedValue(memoryStatus());
    integrationsMock.mockReturnValue(ollamaReady(false));
    render(() => <MemoryAndAiPanel />);
    expect(await screen.findByText("Companion Memory isn't connected yet.")).toBeTruthy();
  });

  it('says the status is unavailable when the request fails, without breaking the step', async () => {
    memoryStatusMock.mockRejectedValue(new Error('network down'));
    integrationsMock.mockReturnValue(ollamaReady(true));
    render(() => <MemoryAndAiPanel />);
    expect(await screen.findByText('Companion Memory status is unavailable right now.')).toBeTruthy();
    expect(screen.getByText('AI is ready on this server.')).toBeTruthy();
  });

  it('links to Settings for connecting or changing either', async () => {
    memoryStatusMock.mockResolvedValue(memoryStatus());
    integrationsMock.mockReturnValue(ollamaReady(false));
    render(() => <MemoryAndAiPanel />);
    const link = await screen.findByText('Settings');
    expect(link.getAttribute('href')).toBe('/settings');
  });
});
