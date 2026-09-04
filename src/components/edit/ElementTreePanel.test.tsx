import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ElementTreePanel } from './ElementTreePanel';
import type { ComponentAwareTreeNode } from '../../hooks/useElementTree';
import type { SourceRef } from '../../lib/components/types';

function sourceRef(file: string): SourceRef {
  return { file, start: 0, end: 1, line: 1, column: 1, contentHash: 'hash' };
}

describe('ElementTreePanel', () => {
  it('describes pinning the floating panel and unpinning the docked panel', () => {
    const onTogglePin = vi.fn();
    const props = {
      tree: { id: 1, tag: 'body', cls: '', text: '', children: [] },
      truncated: false,
      selectedId: 1,
      affectedIds: [],
      onSelect: vi.fn(),
      onHover: vi.fn(),
      projectPath: '/tmp/project',
      selectedSignature: null,
      onTogglePin,
    };

    const { rerender } = render(<ElementTreePanel {...props} pinned={false} />);
    const pinButton = screen.getByRole('button', { name: 'Pin Elements panel to the window' });
    expect(pinButton).toHaveAttribute('title', 'Pin to the window');
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');

    rerender(<ElementTreePanel {...props} pinned />);
    const unpinButton = screen.getByRole('button', { name: 'Unpin Elements panel' });
    expect(unpinButton).toHaveAttribute('title', 'Unpin — float over the workspace');
    expect(unpinButton).toHaveAttribute('aria-pressed', 'true');
  });

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

  it('swaps supported tag names for the Insert Element icons', () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [
            { id: 2, tag: 'div', cls: 'card', text: '', children: [] },
            { id: 3, tag: 'main', cls: '', text: '', children: [] },
            { id: 4, tag: 'header', cls: '', text: '', children: [] },
            { id: 5, tag: 'nav', cls: '', text: '', children: [] },
            { id: 6, tag: 'code', cls: '', text: '', children: [] },
          ],
        }}
        truncated={false}
        selectedId={1}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    const panel = screen.getByTestId('element-tree-panel');
    const toggle = screen.getByRole('button', { name: 'Show tag icons' });
    expect(panel.querySelector('[data-tree-id="2"] .ss-tree-tag')).toHaveTextContent('div');

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Show tag names' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      panel.querySelector('[data-tree-id="2"] [data-icon-name="ElementDivIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="2"] .ss-tree-tag')).not.toBeInTheDocument();
    expect(
      panel.querySelector('[data-tree-id="3"] [data-icon-name="ElementMainIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="3"] .ss-tree-tag')).not.toBeInTheDocument();
    expect(
      panel.querySelector('[data-tree-id="4"] [data-icon-name="ElementHeadIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="4"] .ss-tree-tag')).not.toBeInTheDocument();
    expect(
      panel.querySelector('[data-tree-id="5"] [data-icon-name="ElementNavIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="5"] .ss-tree-tag')).not.toBeInTheDocument();
    expect(
      panel.querySelector('[data-tree-id="6"] [data-icon-name="ElementCodeBlockIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="6"] .ss-tree-tag')).not.toBeInTheDocument();
  });

  it('keeps component children opaque until the component is focused', () => {
    const component: ComponentAwareTreeNode = {
      kind: 'component',
      key: 'card:instance-1',
      componentId: 'react:src/Card.tsx#Card',
      instanceId: 'react:src/Page.tsx:12',
      name: 'Card',
      confidence: 'exact',
      hostNodeIds: [2],
      definition: sourceRef('src/Card.tsx'),
      invocation: sourceRef('src/Page.tsx'),
      children: [{ kind: 'element', id: 2, tag: 'section', cls: 'card', text: '', children: [] }],
    };
    const componentTree: ComponentAwareTreeNode = {
      kind: 'element',
      id: 1,
      tag: 'body',
      cls: '',
      text: '',
      children: [component],
    };
    const onComponentSelect = vi.fn();
    const onComponentFocus = vi.fn();
    const onComponentExitFocus = vi.fn();

    const { rerender } = render(
      <ElementTreePanel
        tree={componentTree}
        componentTree={componentTree}
        truncated={false}
        selectedId={1}
        selectedComponentKey={null}
        componentFocusPath={[]}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        onComponentSelect={onComponentSelect}
        onComponentFocus={onComponentFocus}
        onComponentExitFocus={onComponentExitFocus}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    const row = screen.getByRole('button', { name: 'Component Card' });
    expect(row).toHaveClass('ss-tree-row--component');
    expect(
      screen.queryByTestId('element-tree-panel')?.querySelector('[data-tree-id="2"]')
    ).toBeNull();

    fireEvent.click(row);
    expect(onComponentSelect).toHaveBeenCalledWith(component);
    fireEvent.doubleClick(row);
    expect(onComponentFocus).toHaveBeenCalledWith(component);

    rerender(
      <ElementTreePanel
        tree={componentTree}
        componentTree={componentTree}
        truncated={false}
        selectedId={1}
        selectedComponentKey={component.key}
        componentFocusPath={[{ key: component.key, name: component.name }]}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        onComponentSelect={onComponentSelect}
        onComponentFocus={onComponentFocus}
        onComponentExitFocus={onComponentExitFocus}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    expect(screen.getByRole('button', { name: 'Component Card (focused)' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(
      screen.getByTestId('element-tree-panel').querySelector('[data-tree-id="2"]')
    ).toBeInTheDocument();
    expect(
      screen
        .getByTestId('element-tree-panel')
        .querySelector('.ss-tree-panel__component-breadcrumb [aria-current="page"]')
    ).toHaveTextContent('Card');
    fireEvent.keyDown(screen.getByTestId('element-tree-panel'), { key: 'Escape' });
    expect(onComponentExitFocus).toHaveBeenCalledTimes(1);
  });
});
