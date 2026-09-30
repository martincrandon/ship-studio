import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TeamThreadsPanel } from './TeamThreadsPanel';
import type { TeamThread } from '../../lib/team';
import { clearThreadSelection } from '../../lib/teamStore';

vi.mock('../../lib/teamStore', async () => {
  // Selection is real store state, because the whole point of moving it there
  // was that the pin and the row cannot disagree about it.
  const actual = await vi.importActual<typeof import('../../lib/teamStore')>('../../lib/teamStore');
  return { ...actual, replyToThread: vi.fn(), setThreadResolved: vi.fn() };
});

const me = { login: 'julian', name: 'Julian', avatarUrl: null };

function thread(id: string, pin: number, body: string): TeamThread {
  return {
    id,
    projectName: 'site',
    projectPath: '/site',
    branch: 'main',
    route: '/',
    target: 'h1 · Real Food',
    pin,
    resolved: false,
    resolvedBy: null,
    messages: [{ id, actor: me, at: Date.now(), body }],
  };
}

it('lists the open threads it was given', () => {
  render(
    <TeamThreadsPanel
      threads={[thread('t1', 1, 'Make this smaller'), thread('t2', 2, 'Wrong copy')]}
      now={Date.now()}
      compact
    />
  );

  // Twice each: once as the row preview, once in the reader beside it.
  expect(screen.getAllByText('Make this smaller').length).toBeGreaterThan(0);
  expect(screen.getByText('Wrong copy')).toBeInTheDocument();
  expect(screen.queryByText('No open comments')).not.toBeInTheDocument();
});

beforeEach(() => {
  clearThreadSelection();
});

it('offers no send button until something is ticked, then names the count', () => {
  const onSendToAgent = vi.fn<(threads: TeamThread[]) => void>();
  render(
    <TeamThreadsPanel
      threads={[thread('t1', 1, 'Make this smaller'), thread('t2', 2, 'Wrong copy')]}
      now={Date.now()}
      compact
      onSendToAgent={onSendToAgent}
      agentLabel="Claude Code · Terminal 1"
    />
  );

  // Nothing pre-selected: the button is absent rather than present-and-disabled.
  expect(screen.queryByRole('button', { name: /Send comment/ })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Send comment #1 to an agent' }));
  expect(screen.getByRole('button', { name: 'Send to agent' })).toBeInTheDocument();
  expect(screen.getByText('1 selected')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Send comment #2 to an agent' }));
  expect(screen.getByText('2 selected')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  expect(onSendToAgent).toHaveBeenCalledTimes(1);
  expect(onSendToAgent.mock.calls[0][0].map((sent) => sent.id)).toEqual(['t1', 't2']);
});

it('shows no ticks at all where there is no agent to send to', () => {
  render(
    <TeamThreadsPanel threads={[thread('t1', 1, 'Make this smaller')]} now={Date.now()} compact />
  );
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('says why an element cannot be commented on, instead of showing a list that never grows', () => {
  render(
    <TeamThreadsPanel
      threads={[]}
      now={Date.now()}
      compact
      pickerHint="Start the preview to comment on an element."
    />
  );
  expect(screen.getByText('Start the preview to comment on an element.')).toBeInTheDocument();
});

it('says nothing when picking is available', () => {
  render(<TeamThreadsPanel threads={[]} now={Date.now()} compact />);
  expect(screen.queryByText(/Start the preview/)).not.toBeInTheDocument();
});
