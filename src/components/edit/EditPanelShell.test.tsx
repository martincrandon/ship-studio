import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditPanelShell } from './EditPanelShell';

describe('EditPanelShell', () => {
  it.each(['CSS', 'Visual Editor', 'Component'] as const)(
    'renders the Edit title with the %s context label',
    (context) => {
      render(
        <EditPanelShell
          context={context}
          pinned={false}
          onTogglePin={vi.fn()}
          onClose={vi.fn()}
        >
          <div>panel content</div>
        </EditPanelShell>
      );

      expect(screen.getByText('Edit')).toBeInTheDocument();
      expect(screen.getByText(context)).toBeInTheDocument();
      expect(screen.getByText('panel content')).toBeInTheDocument();
      const closeButton = screen.queryByRole('button', { name: 'Close Edit panel' });
      if (context === 'Component') {
        expect(closeButton).not.toBeInTheDocument();
      } else {
        expect(closeButton).toBeInTheDocument();
      }
    }
  );

  it('uses generic edit-panel actions for pinning and closing outside Component context', () => {
    const onTogglePin = vi.fn();
    const onClose = vi.fn();

    render(
      <EditPanelShell context="CSS" pinned onTogglePin={onTogglePin} onClose={onClose}>
        <div />
      </EditPanelShell>
    );

    screen.getByRole('button', { name: 'Unpin Edit panel' }).click();
    screen.getByRole('button', { name: 'Close Edit panel' }).click();

    expect(onTogglePin).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps Component as the persistent default context without a close action', () => {
    const onClose = vi.fn();

    render(
      <EditPanelShell context="Component" onClose={onClose}>
        <div />
      </EditPanelShell>
    );

    expect(screen.queryByRole('button', { name: 'Close Edit panel' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
