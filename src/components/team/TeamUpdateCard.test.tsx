import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TeamUpdateCard } from './TeamUpdateCard';
import type { TeamUpdate } from '../../lib/team';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

function update(agentName: string): TeamUpdate {
  return {
    id: 'update-1',
    at: Date.now(),
    actor: { login: 'julian', name: 'Julian', avatarUrl: null },
    writtenBy: 'agent',
    agentName,
    headline: 'Updated the page',
    why: null,
    changes: [],
    asks: null,
    branch: 'main',
    status: 'working',
    projectName: 'site',
    projectPath: '/site',
    commits: [],
    files: [],
    prNumber: null,
    buildError: null,
    githubUrl: null,
  };
}

it.each(['Codex', 'Claude Code', 'Cursor'])(
  'shows only the %s icon with its description',
  (agentName) => {
    render(
      <TeamUpdateCard
        update={update(agentName)}
        expanded={false}
        onToggleExpanded={vi.fn()}
        isNew={false}
        now={Date.now()}
      />
    );

    const description = `Summarised by ${agentName}, which did the work`;
    expect(screen.getByRole('img', { name: description })).toHaveAttribute('title', description);
    expect(screen.queryByText(agentName)).not.toBeInTheDocument();
  }
);
