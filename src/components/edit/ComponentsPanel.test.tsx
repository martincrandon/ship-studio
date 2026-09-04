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

const { trackEventMock } = vi.hoisted(() => ({ trackEventMock: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ trackEvent: trackEventMock }));

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
  componentTreeBoundary: true,
  focusedVisualEditing: false,
  duplicateDefinition: false,
  renameDefinition: false,
  deleteDefinition: false,
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
  it('tracks catalog interactions without source identifiers', () => {
    const props = panelProps();
    const view = render(<ComponentsPanel {...props} selectedComponentId={null} />);

    expect(trackEventMock).toHaveBeenCalledWith('components_panel_opened', {
      status: 'partial',
      dialect_count: 2,
      catalog_count_bucket: '1-3',
      capability_count: 14,
    });

    fireEvent.click(screen.getByTitle('Button · src/components/Button.tsx'));
    expect(trackEventMock).toHaveBeenCalledWith('component_selected', {
      dialect: 'react',
      status: 'ready',
      usage_count_bucket: '1-3',
      capability_count: 8,
      has_instance_binding: true,
      has_place: true,
    });

    view.rerender(<ComponentsPanel {...props} selectedComponentId={button.id} />);
    fireEvent.click(screen.getByRole('tab', { name: /Usages/ }));
    fireEvent.click(screen.getByRole('button', { name: /src\/pages\/index\.tsx:12/ }));
    expect(trackEventMock).toHaveBeenCalledWith('component_usage_opened', {
      dialect: 'react',
      status: 'ready',
      usage_count_bucket: '1-3',
      capability_count: 8,
    });

    for (const [, properties] of trackEventMock.mock.calls) {
      expect(properties).not.toHaveProperty('component_id');
      expect(properties).not.toHaveProperty('component_name');
      expect(properties).not.toHaveProperty('file');
      expect(properties).not.toHaveProperty('source');
    }
  });

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
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose insertion position' }), {
      target: { value: 'before' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Set required label' }), {
      target: { value: 'Ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insert component' }));
    expect(props.onPlace).toHaveBeenCalledWith(
      button.id,
      {
        label: { kind: 'string', value: 'Ship it' },
      },
      'before'
    );
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

  it('opens the reviewed duplicate flow for a capable React definition', () => {
    const props = panelProps();
    const onDuplicate = vi.fn();
    const duplicateIndex = {
      ...index,
      components: [
        { ...button, capabilities: { ...button.capabilities, duplicateDefinition: true } },
        hero,
      ],
    };
    render(<ComponentsPanel {...props} index={duplicateIndex} onDuplicate={onDuplicate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New component name' }), {
      target: { value: 'ButtonCopy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review duplicate' }));

    expect(onDuplicate).toHaveBeenCalledWith({
      componentId: button.id,
      newName: 'ButtonCopy',
      destinationFile: 'src/components/ButtonCopy.tsx',
    });
  });

  it('opens the reviewed rename flow for a capable named React definition', () => {
    const props = panelProps();
    const onRename = vi.fn();
    const renameIndex = {
      ...index,
      components: [
        { ...button, capabilities: { ...button.capabilities, renameDefinition: true } },
        hero,
      ],
    };
    render(<ComponentsPanel {...props} index={renameIndex} onRename={onRename} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New component name' }), {
      target: { value: 'ActionButton' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review rename' }));

    expect(onRename).toHaveBeenCalledWith({
      componentId: button.id,
      newName: 'ActionButton',
    });
  });

  it('requires destructive confirmation before opening the reviewed delete flow', () => {
    const props = panelProps();
    const onDelete = vi.fn();
    const deleteIndex = {
      ...index,
      components: [
        { ...button, capabilities: { ...button.capabilities, deleteDefinition: true } },
        hero,
      ],
    };
    render(<ComponentsPanel {...props} index={deleteIndex} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('checkbox', {
      name: 'Confirm deleting the component and all usages',
    });
    expect(screen.getByRole('button', { name: 'Review deletion' })).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));

    expect(onDelete).toHaveBeenCalledWith({
      componentId: button.id,
      removeAllUsages: true,
    });
  });

  it('shows recoverable loading and error states', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <ComponentsPanel {...panelProps()} index={null} loading onRefresh={onRefresh} />
    );
    expect(screen.getByRole('status', { name: 'Loading components' })).toHaveClass(
      'ss-pixel-loader',
      'ss-pixel-loader--rings',
      'ss-pixel-loader--lg'
    );

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

  it('uses an explicit reset action and keeps optional booleans three-state', () => {
    const onEditProp = vi.fn();
    const boolComponent: ComponentDescriptor = {
      ...button,
      props: [
        ...button.props,
        {
          name: 'featured',
          required: false,
          typeText: 'boolean',
          defaultValue: { kind: 'boolean', value: false },
          choices: null,
          control: 'boolean',
          source: source('src/components/Button.tsx', 7),
          diagnostics: [],
        },
      ],
    };
    const usage: ComponentInstance = {
      ...buttonUsage,
      props: {
        ...buttonUsage.props,
        featured: {
          kind: 'static',
          value: { kind: 'boolean', value: true },
          source: source('src/pages/index.tsx', 12),
        },
      },
    };
    render(
      <ComponentInstanceControls
        instance={usage}
        component={boolComponent}
        onEditProp={onEditProp}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset tone' }));
    expect(onEditProp).toHaveBeenCalledWith(usage, 'tone', null);
    const featured = screen.getByRole('combobox', { name: 'Set featured' });
    expect(featured).toHaveValue('true');
    fireEvent.change(featured, { target: { value: '' } });
    expect(onEditProp).toHaveBeenCalledWith(usage, 'featured', null);
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
