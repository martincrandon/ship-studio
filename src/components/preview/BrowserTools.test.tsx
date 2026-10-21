import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { inspectStore } from '../../lib/inspectStore';
import { BrowserTools } from './BrowserTools';

const { trackEventMock } = vi.hoisted(() => ({ trackEventMock: vi.fn() }));

vi.mock('../../lib/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/analytics')>();
  return { ...actual, trackEvent: trackEventMock };
});

function addConsoleEntry() {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: 'http://localhost:1420',
      data: {
        source: 'shipstudio-inspect',
        type: 'console',
        level: 'error',
        args: ['Preview failed to render'],
        t: 1,
      },
    })
  );
}

describe('BrowserTools send to agent', () => {
  beforeEach(() => {
    trackEventMock.mockClear();
    inspectStore.clearConsole();
    addConsoleEntry();
  });

  afterEach(() => {
    cleanup();
    inspectStore.clearConsole();
  });

  it('keeps captured output and skips analytics when the handoff is rejected', () => {
    const onSendToAgent = vi.fn(() => false as const);
    render(<BrowserTools onSendToAgent={onSendToAgent} />);

    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));

    expect(onSendToAgent).toHaveBeenCalledWith(expect.stringContaining('Preview failed to render'));
    expect(screen.getByText('Preview failed to render')).toBeInTheDocument();
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('records an accepted handoff', () => {
    render(<BrowserTools onSendToAgent={() => 'chat-draft'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));

    expect(trackEventMock).toHaveBeenCalledWith(
      'browser_tools_sent_to_agent',
      expect.objectContaining({ tab: 'console', entry_count: 1, had_data: true })
    );
  });
});
