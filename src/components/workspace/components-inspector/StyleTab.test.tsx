import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { deriveStyleTabState, StyleTab, type StyleTabStateInput } from './StyleTab';

function input(overrides: Partial<StyleTabStateInput> = {}): StyleTabStateInput {
  return {
    frameStatus: 'live',
    hasSelectedElement: true,
    sourceStatus: 'exact',
    editorMode: 'tailwind',
    editMainConfirmed: false,
    editingCapability: true,
    ...overrides,
  };
}

describe('deriveStyleTabState', () => {
  it('returns an empty state when no component frame is selected', () => {
    expect(deriveStyleTabState(input({ frameStatus: 'none', hasSelectedElement: false }))).toEqual({
      kind: 'empty',
      canMutate: false,
    });
  });

  it.each([
    ['loading', 'The frame is still loading.'],
    ['cached', 'Cached snapshots are inspection-only.'],
    ['unsupported', 'This adapter is catalog-only.'],
    ['error', 'The renderer failed to start.'],
  ] as const)('keeps a %s frame unavailable with its honest reason', (frameStatus, reason) => {
    expect(deriveStyleTabState(input({ frameStatus, frameReason: reason }))).toEqual({
      kind: 'unavailable',
      status: frameStatus,
      reason,
      canMutate: false,
    });
  });

  it('transitions from frame loading to selected controls when readiness completes', () => {
    const { rerender } = render(
      <StyleTab
        {...input({ frameStatus: 'loading', hasSelectedElement: false })}
        frameReason="Waiting for the renderer handshake."
      />
    );

    expect(screen.getByTestId('component-inspector-style-tab')).toHaveAttribute(
      'data-style-tab-state',
      'unavailable'
    );

    rerender(<StyleTab {...input({ frameStatus: 'live', hasSelectedElement: true })} />);

    expect(screen.getByTestId('component-inspector-style-tab')).toHaveAttribute(
      'data-style-tab-state',
      'awaiting-confirmation'
    );
  });

  it('prompts for an element when the live frame has no selection', () => {
    expect(deriveStyleTabState(input({ hasSelectedElement: false }))).toEqual({
      kind: 'prompt',
      message: 'Select an element in the frame or Elements panel',
      canMutate: false,
    });
  });

  it('keeps a selected element read-only when its exact source is unproven', () => {
    expect(
      deriveStyleTabState(
        input({
          sourceStatus: 'unproven',
          sourceReason: 'The resolver returned an ambiguous child range.',
        })
      )
    ).toEqual({
      kind: 'readonly',
      mode: 'tailwind',
      reason: 'The resolver returned an ambiguous child range.',
      canMutate: false,
    });
  });

  it('waits for Edit main confirmation after supported exact selection', () => {
    expect(deriveStyleTabState(input())).toEqual({
      kind: 'awaiting-confirmation',
      mode: 'tailwind',
      canMutate: false,
    });
  });

  it('returns a confirmed editable Tailwind state', () => {
    expect(deriveStyleTabState(input({ editMainConfirmed: true }))).toEqual({
      kind: 'editable',
      mode: 'tailwind',
      canMutate: true,
    });
  });

  it('returns a confirmed editable CSS state', () => {
    expect(deriveStyleTabState(input({ editorMode: 'css', editMainConfirmed: true }))).toEqual({
      kind: 'editable',
      mode: 'css',
      canMutate: true,
    });
  });

  it('stays read-only when the renderer withholds editing even after confirmation', () => {
    expect(
      deriveStyleTabState(
        input({
          editMainConfirmed: true,
          editingCapability: false,
          editingCapabilityReason: 'Renderer editing is disabled for this release.',
        })
      )
    ).toEqual({
      kind: 'readonly',
      mode: 'tailwind',
      reason: 'Renderer editing is disabled for this release.',
      canMutate: false,
    });
  });

  it('does not expose an Edit-main prompt when the target is inspection-only', () => {
    render(
      <StyleTab
        {...input({ editMainConfirmed: true, editingCapability: false })}
        onRequestEditMain={vi.fn()}
        controls={<button type="button">mutate</button>}
        readOnlyControls={<span>computed styles</span>}
      />
    );

    expect(screen.getByTestId('component-inspector-style-tab')).toHaveAttribute(
      'data-style-tab-state',
      'readonly'
    );
    expect(screen.getByText(/This component frame is inspection-only/)).toBeInTheDocument();
    expect(screen.getByText('computed styles')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mutate' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('component-inspector-style-tab-edit-main')).not.toBeInTheDocument();
  });

  it('reports a live frame without a supported editor as unavailable', () => {
    expect(
      deriveStyleTabState(
        input({ editorMode: null, editorReason: 'This project has no accepted style editor.' })
      )
    ).toEqual({
      kind: 'unavailable',
      status: 'unsupported',
      reason: 'This project has no accepted style editor.',
      canMutate: false,
    });
  });
});

describe('StyleTab', () => {
  it('renders the empty state without supplied editor controls', () => {
    render(
      <StyleTab
        {...input({ frameStatus: 'none', hasSelectedElement: false })}
        controls={<button type="button">mutate</button>}
      />
    );

    expect(screen.getByTestId('component-inspector-style-tab')).toHaveAttribute(
      'data-style-tab-state',
      'empty'
    );
    expect(screen.getByText('Select a component frame to inspect styles.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mutate' })).not.toBeInTheDocument();
  });

  it('renders an unavailable reason for loading, cached, unsupported, and error states', () => {
    for (const frameStatus of ['loading', 'cached', 'unsupported', 'error'] as const) {
      const { unmount } = render(
        <StyleTab
          {...input({
            frameStatus,
            frameReason: `${frameStatus} reason from renderer`,
          })}
        />
      );
      expect(
        screen.getByTestId('component-inspector-style-tab-unavailable-reason')
      ).toHaveTextContent(`${frameStatus} reason from renderer`);
      unmount();
    }
  });

  it('shows the live no-element prompt', () => {
    render(<StyleTab {...input({ hasSelectedElement: false })} />);
    expect(
      screen.getByText('Select an element in the frame or Elements panel')
    ).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('keeps the CSS header and actions visible while waiting for an element', () => {
    const onClose = vi.fn();
    const onTogglePin = vi.fn();
    render(
      <StyleTab
        {...input({ editorMode: 'css', hasSelectedElement: false })}
        pinned
        onTogglePin={onTogglePin}
        onClose={onClose}
      />
    );

    expect(screen.getByText('CSS')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unpin CSS panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close CSS panel' }));
    expect(onTogglePin).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders explicit read-only controls and no mutation affordance for unproven source', () => {
    render(
      <StyleTab
        {...input({ sourceStatus: 'unproven', sourceReason: 'Exact source is unavailable.' })}
        controls={<button type="button">mutate</button>}
        readOnlyControls={<span>computed styles</span>}
      />
    );

    expect(screen.getByTestId('component-inspector-style-tab-readonly')).toHaveAttribute(
      'aria-readonly',
      'true'
    );
    expect(screen.getByText('Exact source is unavailable.')).toBeInTheDocument();
    expect(screen.getByText('computed styles')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mutate' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('component-inspector-style-tab-edit-main')).not.toBeInTheDocument();
  });

  it('can leave an embedded editor in charge of its read-only diagnostic', () => {
    render(
      <StyleTab
        {...input({ sourceStatus: 'unproven', sourceReason: 'Exact source is unavailable.' })}
        showStateMessage={false}
        readOnlyControls={<span>inline diagnostic</span>}
      />
    );

    expect(screen.queryByTestId('component-inspector-style-tab-message')).not.toBeInTheDocument();
    expect(screen.getByText('inline diagnostic')).toBeInTheDocument();
  });

  it('exposes only an Edit-main request while exact selection awaits confirmation', () => {
    const onRequestEditMain = vi.fn();
    render(
      <StyleTab
        {...input()}
        onRequestEditMain={onRequestEditMain}
        readOnlyControls={<span>style preview</span>}
      />
    );

    expect(screen.getByTestId('component-inspector-style-tab')).toHaveAttribute(
      'data-style-tab-state',
      'awaiting-confirmation'
    );
    expect(screen.getByText('style preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit main component' }));
    expect(onRequestEditMain).toHaveBeenCalledTimes(1);
  });

  it('renders supplied controls only after Edit main is confirmed', () => {
    render(
      <StyleTab
        {...input({ editorMode: 'css', editMainConfirmed: true })}
        controls={<span>CSS cascade controls</span>}
      />
    );

    expect(screen.getByTestId('component-inspector-style-tab-controls')).toBeInTheDocument();
    expect(screen.getByText('CSS cascade controls')).toBeInTheDocument();
    expect(screen.getByTestId('component-inspector-style-tab')).not.toHaveAttribute(
      'aria-readonly'
    );
  });

  it('passes mutation authority to supplied render controls', () => {
    render(
      <StyleTab
        {...input({ editMainConfirmed: true })}
        renderControls={({ canMutate, state }) => (
          <span>
            {state.kind}:{String(canMutate)}
          </span>
        )}
      />
    );

    expect(screen.getByText('editable:true')).toBeInTheDocument();
  });
});
