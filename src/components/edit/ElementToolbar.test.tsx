import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { StructureSelection } from '../../hooks/useElementStructure';
import type { SelectedComponent } from '../../hooks/useElementTree';
import { ElementToolbar } from './ElementToolbar';

function renderToolbar(tagName: string) {
  const selection: StructureSelection = {
    signature: {
      tagName,
      className: 'hero-title secondary',
      ancestorClasses: [],
    },
    rect: { top: 80, left: 40, width: 120, height: 24 },
    count: 1,
    nodeId: 1,
  };

  return render(
    <ElementToolbar
      selection={selection}
      bounds={{ w: 800, h: 600 }}
      busy={false}
      hidden={false}
      onInsert={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

describe('ElementToolbar', () => {
  it('uses the matching tag icon while keeping the class selector visible', () => {
    const { container } = renderToolbar('p');

    expect(container.querySelector('[data-icon-name="ElementParagraphIcon"]')).toBeInTheDocument();
    expect(container.querySelector('.ss-el-toolbar__tag')).not.toBeInTheDocument();
    expect(screen.getByText('.hero-title')).toBeInTheDocument();
    expect(
      screen.getByTestId('element-toolbar').querySelector('.ss-el-toolbar__selection')
    ).toHaveAttribute('aria-label', 'Selected element: p .hero-title');
    expect(
      screen.getByTestId('element-toolbar').querySelector('.ss-el-toolbar__selection')
    ).not.toHaveAttribute('title');
    expect(
      screen.getByTestId('element-toolbar').querySelector('.ss-el-toolbar__actions')
    ).toBeInTheDocument();

    const actions = screen.getByRole('group', { name: 'Element actions' });
    for (const iconName of ['PlusIcon', 'DuplicateIcon', 'TrashIcon']) {
      expect(actions.querySelector(`[data-icon-name="${iconName}"]`)).toHaveClass(
        'ss-el-toolbar__control-icon'
      );
    }
  });

  it('falls back to the tag name when no matching icon exists', () => {
    const { container } = renderToolbar('article');

    expect(container.querySelector('.ss-el-toolbar__tag')).toHaveTextContent('article');
    expect(container.querySelector('.ss-el-toolbar__tag-icon')).not.toBeInTheDocument();
  });

  it('renders the component selection affordance in the semantic component accent', () => {
    const onComponentFocus = vi.fn();
    const componentSelection: SelectedComponent = {
      key: 'card:instance-1',
      componentId: 'react:src/Card.tsx#Card',
      instanceId: 'react:src/Page.tsx:12',
      name: 'Card',
      hostNodeIds: [2],
      confidence: 'exact',
      rect: { top: 80, left: 40, width: 120, height: 24 },
    };

    const { container } = render(
      <ElementToolbar
        selection={null}
        componentSelection={componentSelection}
        bounds={{ w: 800, h: 600 }}
        busy={false}
        hidden={false}
        onInsert={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onComponentFocus={onComponentFocus}
      />
    );

    expect(container.querySelector('.ss-el-toolbar--component')).toBeInTheDocument();
    expect(
      container.querySelector('.ss-el-toolbar__component-icon[data-icon-name="ComponentsIcon"]')
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Selected component: Card' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Component actions' })).toHaveClass(
      'ss-el-toolbar__actions--component'
    );
    expect(
      container.querySelector(
        '.ss-el-toolbar__actions--component [data-icon-name="ComponentsIcon"]'
      )
    ).toHaveClass('ss-el-toolbar__control-icon');
    expect(screen.getByRole('button', { name: 'Focus component' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Focus component' }));
    expect(onComponentFocus).toHaveBeenCalledTimes(1);
  });
});
