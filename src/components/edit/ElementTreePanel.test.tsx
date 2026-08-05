import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ElementTreePanel } from './ElementTreePanel';

describe('ElementTreePanel', () => {
  it('shows view-only state without a redundant Visual tab', () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [{ id: 2, tag: 'div', cls: 'card', text: '', children: [] }],
        }}
        truncated={false}
        selectedId={1}
        affectedIds={[2]}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    expect(screen.getByText('View only')).toHaveAttribute(
      'data-tooltip-content',
      'Turn on edit mode to select and edit elements.'
    );
    expect(screen.queryByText('View-only mode')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Visual' })).not.toBeInTheDocument();
    expect(
      screen.getByTestId('element-tree-panel').querySelector('[data-tree-id="2"]')
    ).toHaveClass('affected');
  });
});
