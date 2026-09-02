import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ComponentCapabilities,
  ComponentDescriptor,
  ComponentIndex,
  ComponentInstance,
  SourceRef,
} from '../../lib/components/types';
import { ComponentInstanceControls } from './ComponentInstanceControls';
import { ComponentsPanel } from './ComponentsPanel';
import { EditMainBanner } from './EditMainBanner';

function source(file: string, line: number): SourceRef {
  return { file, start: line, end: line + 10, line, column: 1, contentHash: `${file}-hash` };
}

const capabilities: ComponentCapabilities = {
  catalog: true,
  usageGraph: true,
  definitionBinding: true,
  instanceBinding: true,
  place: true,
  editStaticProps: true,
  editSlots: false,
  editMain: true,
  extract: false,
  isolatedPreview: false,
};

const button: ComponentDescriptor = {
  id: 'react:src/components/Button.tsx:Button',
  dialect: 'react',
  kind: 'component',
  name: 'Button',
  localName: 'Button',
  exportName: 'Button',
  description: 'A reusable action button.',
  definition: source('src/components/Button.tsx', 4),
  props: [
    {
      name: 'label',
      required: true,
      typeText: 'string',
      defaultValue: null,
      choices: null,
      control: 'text',
      source: source('src/components/Button.tsx', 5),
      diagnostics: [],
    },
    {
      name: 'tone',
      required: false,
      typeText: "'neutral' | 'accent'",
      defaultValue: { kind: 'string', value: 'neutral' },
      choices: [
        { kind: 'string', value: 'neutral' },
        { kind: 'string', value: 'accent' },
      ],
      control: 'select',
      source: source('src/components/Button.tsx', 6),
      diagnostics: [],
    },
  ],
  slots: [],
  variantProps: ['tone'],
  usageCount: 2,
  capabilities,
  diagnostics: [],
};

const hero: ComponentDescriptor = {
  ...button,
  id: 'astro:src/components/Hero.astro:default',
  dialect: 'astro',
  kind: 'component',
  name: 'Hero',
  localName: 'Hero',
  exportName: null,
  description: null,
  definition: source('src/components/Hero.astro', 1),
  props: [],
  variantProps: [],
  usageCount: 0,
  capabilities: { ...capabilities, place: false, instanceBinding: false },
  diagnostics: [
    { code: 'dynamic-prop', severity: 'warning', message: 'A dynamic prop is read-only.' },
  ],
};

const buttonUsage: ComponentInstance = {
  id: 'button-usage-1',
  componentId: button.id,
  invocation: source('src/pages/index.tsx', 12),
  containingComponentId: null,
  route: '/',
  props: {
    label: {
      kind: 'static',
      value: { kind: 'string', value: 'Launch' },
      source: source('src/pages/index.tsx', 12),
    },
    tone: {
      kind: 'static',
      value: { kind: 'string', value: 'accent' },
      source: source('src/pages/index.tsx', 12),
    },
  },
  slots: [],
};

const index: ComponentIndex = {
  revision: 'revision-1',
  partial: true,
  profile: {
    projectType: null,
    primaryDialect: 'react',
    dialects: ['react', 'astro'],
    workspaceRoot: '.',
    capabilities: {
      react: capabilities,
      astro: hero.capabilities,
      vue: { ...capabilities, catalog: false },
      svelte: { ...capabilities, catalog: false },
      shopify: { ...capabilities, catalog: false },
      'web-component': { ...capabilities, catalog: false },
      'react-native': { ...capabilities, catalog: false },
      flutter: { ...capabilities, catalog: false },
    },
    diagnostics: [],
  },
  components: [button, hero],
  instances: [buttonUsage],
  importEdges: [],
  diagnostics: [{ code: 'partial', severity: 'warning', message: 'One file could not be parsed.' }],
};

function panelProps() {
  return {
    index,
    selectedComponentId: button.id,
    onSelect: vi.fn(),
    onPlace: vi.fn(),
    onOpenSource: vi.fn(),
    onRefresh: vi.fn(),
    onSelectUsage: vi.fn(),
  };
}

describe('ComponentsPanel', () => {
  it('deselects the active component when its row is clicked again', () => {
    const props = panelProps();
    const { rerender } = render(<ComponentsPanel {...props} />);

    fireEvent.click(screen.getByTitle('Button · src/components/Button.tsx'));
    expect(props.onSelect).toHaveBeenCalledWith(null);

    rerender(<ComponentsPanel {...props} selectedComponentId={null} />);
    expect(screen.queryByTestId('component-details')).not.toBeInTheDocument();
  });

  it('renders grouped definitions, search, details, usages, and source actions', () => {
    const props = panelProps();
    const onEnterEditMain = vi.fn();
    const onTogglePin = vi.fn();
    const { container } = render(
      <ComponentsPanel
        {...props}
        editMain={{
          active: false,
          componentId: null,
          onEnter: onEnterEditMain,
          onExit: vi.fn(),
        }}
        onTogglePin={onTogglePin}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId('components-panel')).toBeInTheDocument();
    expect(
      container.querySelector('.ss-components-panel__workspace--with-details')
    ).toBeInTheDocument();
    expect(container.querySelector('.ss-components-panel__selection')).toBeInTheDocument();
    const catalogResizeHandle = screen.getByRole('separator', {
      name: 'Resize component list',
    });
    expect(catalogResizeHandle).toHaveAttribute('aria-valuenow', '275');
    fireEvent.keyDown(catalogResizeHandle, { key: 'ArrowRight' });
    expect(catalogResizeHandle).toHaveAttribute('aria-valuenow', '285');
    expect(screen.getByPlaceholderText('Search 2 components…')).toBeInTheDocument();
    const refreshButton = screen.getByRole('button', { name: 'Refresh components index' });
    expect(container.querySelector('.ss-components-panel__toolbar')).toContainElement(
      refreshButton
    );
    expect(screen.getAllByText('src/components')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Button' })).toBeInTheDocument();
    expect(
      screen
        .getByTitle('Button · src/components/Button.tsx')
        .querySelector('.ss-components-row__type')
    ).toHaveClass('ss-components-row__type--react');
    expect(
      screen
        .getByTitle('Hero · src/components/Hero.astro')
        .querySelector('.ss-components-row__type')
    ).toHaveClass('ss-components-row__type--astro');
    expect(screen.getByText('Partial index · 1 diagnostic')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Components panel to the window' }));
    expect(onTogglePin).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Place' }));
    expect(screen.getByRole('heading', { name: 'Required props' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Set required label' }), {
      target: { value: 'Ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insert component' }));
    expect(props.onPlace).toHaveBeenCalledWith(button.id, {
      label: { kind: 'string', value: 'Ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open main source' }));
    expect(onEnterEditMain).toHaveBeenCalledWith(button.id);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search components' }), {
      target: { value: 'Hero' },
    });
    expect(screen.getByRole('button', { name: /Hero/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Button · src\/components\/Button/ })
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search components' }), {
      target: { value: 'Button' },
    });
    fireEvent.click(screen.getByRole('tab', { name: /Usages/ }));
    fireEvent.click(screen.getByRole('button', { name: /src\/pages\/index\.tsx:12/ }));
    expect(props.onSelectUsage).toHaveBeenCalledWith(buttonUsage);
    expect(screen.getByRole('button', { name: 'Close Components panel' })).toBeInTheDocument();
  });

  it('shows recoverable loading and error states', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <ComponentsPanel {...panelProps()} index={null} loading onRefresh={onRefresh} />
    );
    expect(screen.getByRole('status', { name: 'Loading components' })).toBeInTheDocument();

    rerender(
      <ComponentsPanel
        {...panelProps()}
        index={null}
        error="The source snapshot is unavailable."
        onRefresh={onRefresh}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not call an informational diagnostic a partial index', () => {
    render(
      <ComponentsPanel
        {...panelProps()}
        index={{
          ...index,
          partial: false,
          diagnostics: [
            { code: 'informational', severity: 'info', message: 'Catalog information.' },
          ],
        }}
      />
    );

    expect(screen.getByText('Index diagnostics · 1 diagnostic')).toBeInTheDocument();
    expect(screen.queryByText(/Partial index/)).not.toBeInTheDocument();
  });
});

describe('ComponentInstanceControls', () => {
  it('emits tagged static values for editable props and keeps dynamic values read-only', () => {
    const onEditProp = vi.fn();
    const dynamicUsage: ComponentInstance = {
      ...buttonUsage,
      props: {
        ...buttonUsage.props,
        label: {
          kind: 'dynamic',
          text: 'copy',
          reason: 'runtime data',
          source: source('src/pages/index.tsx', 12),
        },
      },
    };
    render(
      <ComponentInstanceControls
        instance={dynamicUsage}
        component={button}
        onEditProp={onEditProp}
      />
    );

    expect(screen.queryByRole('textbox', { name: 'Set label' })).not.toBeInTheDocument();
    expect(screen.getByText('Dynamic · runtime data')).toBeInTheDocument();

    const tone = screen.getByRole('combobox', { name: 'Set tone' });
    fireEvent.change(tone, {
      target: { value: JSON.stringify({ kind: 'string', value: 'neutral' }) },
    });
    expect(onEditProp).toHaveBeenCalledWith(dynamicUsage, 'tone', {
      kind: 'string',
      value: 'neutral',
    });
  });

  it('commits text on blur and disables editors while busy', () => {
    const onEditProp = vi.fn();
    const { rerender } = render(
      <ComponentInstanceControls
        instance={buttonUsage}
        component={button}
        onEditProp={onEditProp}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Set label' });
    fireEvent.change(input, { target: { value: 'Ship it' } });
    fireEvent.blur(input);
    expect(onEditProp).toHaveBeenCalledWith(buttonUsage, 'label', {
      kind: 'string',
      value: 'Ship it',
    });

    rerender(
      <ComponentInstanceControls
        instance={buttonUsage}
        component={button}
        onEditProp={onEditProp}
        busy
      />
    );
    expect(screen.getByRole('textbox', { name: 'Set label' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Set tone' })).toBeDisabled();
  });
});

describe('EditMainBanner', () => {
  it('makes definition scope explicit and exposes enter/exit actions', () => {
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const state = { active: false, componentId: null, onEnter, onExit };
    const { rerender } = render(<EditMainBanner component={button} usageCount={2} state={state} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open main source' }));
    expect(onEnter).toHaveBeenCalledWith(button.id);

    rerender(
      <EditMainBanner
        component={button}
        usageCount={2}
        state={{ ...state, active: true, componentId: button.id, pendingChanges: true }}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Main source selected: Button');
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear context' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
