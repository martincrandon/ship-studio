import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useCssAnimations } from '../../hooks/useCssAnimations';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { CascadeRow } from '../../lib/cssCascade';
import type { RuleBody } from '../../lib/cssBody';
import { CASCADE_DISPLAY_ORDER_PREFERENCE_KEY } from '../../lib/cascadePresentation';
import { rowKey } from '../../lib/cssCascade';
import { CssCascadePanel } from './CssCascadePanel';

function makeSettings(): ElementSettings {
  return {
    selectionKey: 'selected-element',
    tag: 'div',
    tagOptions: [],
    canEditTag: false,
    setTag: vi.fn().mockResolvedValue(true),
    classes: ['hero'],
    attributes: [],
    text: '',
    textReason: null,
    canEditText: false,
    setText: vi.fn().mockResolvedValue(true),
    addClass: vi.fn(),
    renameClass: vi.fn(),
    removeClass: vi.fn(),
    setAttribute: vi.fn(),
    renameAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    canEditAttributes: false,
    location: null,
    busy: false,
  };
}

function makeRow(index: number, selector: string, options: Partial<CascadeRow> = {}): CascadeRow {
  return {
    index,
    selector,
    declarations: [],
    specificity: [0, 1, 0],
    sourceOrder: index,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    origin: 'author',
    editable: true,
    file: 'src/styles.css',
    line: index + 1,
    ...options,
  };
}

function makeBody(...properties: Array<[string, string]>): RuleBody {
  return {
    items: properties.map(([prop, value]) => ({
      kind: 'decl' as const,
      prop,
      value,
      important: false,
    })),
  };
}

function renderPanel(
  rows: CascadeRow[],
  bodies: Record<string, RuleBody>,
  selectedClassName = 'hero'
) {
  return render(
    <CssCascadePanel
      selection={{
        signature: { tagName: 'div', className: selectedClassName, ancestorClasses: [] },
        instanceCount: 1,
      }}
      rows={rows}
      loading={false}
      bodies={bodies}
      overridden={{}}
      onChangeBody={vi.fn()}
      onDeleteRule={vi.fn()}
      onWrapRule={vi.fn()}
      onRenameRule={vi.fn()}
      onRenameAtRule={vi.fn()}
      onAddSelector={vi.fn()}
      selectorSuggestions={[]}
      existingSelectors={[]}
      variables={[]}
      animations={[]}
      settings={makeSettings()}
      animationsState={
        {
          animations: [],
          loading: false,
          setBody: vi.fn(),
          create: vi.fn(),
          rename: vi.fn(),
          remove: vi.fn(),
          reload: vi.fn(),
        } as ReturnType<typeof useCssAnimations>
      }
      onClose={vi.fn()}
    />
  );
}

function selectorCard(panel: HTMLElement, selector: string): HTMLElement {
  const card = Array.from(panel.querySelectorAll<HTMLElement>('[data-testid="cascade-card"]')).find(
    (candidate) =>
      Array.from(candidate.querySelectorAll('.ss-cascade-chip__content')).some(
        (content) => content.textContent === selector
      )
  );
  if (!card) throw new Error(`Expected a selector card for ${selector}`);
  return card;
}

function draftMediaGroup(panel: HTMLElement): HTMLElement {
  const group = panel.querySelector<HTMLElement>('.ss-media-query-group.is-incomplete');
  if (!group) throw new Error('Expected the draft media query to match search');
  return group;
}

function addIncompleteMediaSelector(selector: string) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Add selector' })[0]);
  const topInput = screen.getByRole('combobox', { name: 'Add selector' });
  fireEvent.change(topInput, { target: { value: '@media' } });
  fireEvent.keyDown(topInput, { key: 'Enter' });

  const draftGroup = document.querySelector<HTMLElement>('.ss-media-query-group.is-incomplete');
  if (!draftGroup) throw new Error('Expected a draft media query group');
  fireEvent.click(within(draftGroup).getByRole('button', { name: 'Add selector' }));
  const selectorInput = within(draftGroup).getByRole('combobox', { name: 'Add selector' });
  fireEvent.change(selectorInput, { target: { value: selector } });
  fireEvent.keyDown(selectorInput, { key: 'Enter' });
  return draftGroup;
}

function cardOrder(list: HTMLElement): string[] {
  return Array.from(list.querySelectorAll(':scope > [data-testid="cascade-card"]')).map(
    (card) => card.querySelector('.ss-cascade-chip__content')?.textContent ?? ''
  );
}

const ELEMENT_DISPLAY_PREFERENCE_KEYS = [
  'elementTreeShowTagIcons',
  'elementTreeShowTagSansSerif',
  'elementTreeShowTagColors',
];

beforeEach(() => {
  localStorage.removeItem(CASCADE_DISPLAY_ORDER_PREFERENCE_KEY);
  ELEMENT_DISPLAY_PREFERENCE_KEYS.forEach((key) => localStorage.removeItem(key));
});
afterEach(() => {
  localStorage.removeItem(CASCADE_DISPLAY_ORDER_PREFERENCE_KEY);
  ELEMENT_DISPLAY_PREFERENCE_KEYS.forEach((key) => localStorage.removeItem(key));
});

describe('CssCascadePanel controls', () => {
  it('applies the shared Elements display preferences to the selected element label', () => {
    localStorage.setItem('elementTreeShowTagIcons', '1');
    localStorage.setItem('elementTreeShowTagSansSerif', '1');
    localStorage.setItem('elementTreeShowTagColors', '0');

    renderPanel([], {});

    const target = document.querySelector<HTMLElement>('.ss-cascade-target');
    if (!target) throw new Error('Expected the selected-element label');
    expect(target).toHaveClass('ss-cascade-target--sans-serif', 'ss-cascade-target--monochrome');
    expect(target.querySelector('.ss-cascade-target__tag-icon svg')).toHaveAttribute(
      'data-icon-name',
      'ElementDivIcon'
    );
    expect(target.querySelector('.ss-cascade-target__tag')).not.toBeInTheDocument();
    expect(target.querySelector('.ss-cascade-target__class')).toHaveTextContent('.hero');
  });

  it('keeps the tag name next to its icon when there are no classes', () => {
    localStorage.setItem('elementTreeShowTagIcons', '1');

    renderPanel([], {}, '');

    const target = document.querySelector<HTMLElement>('.ss-cascade-target');
    if (!target) throw new Error('Expected the selected-element label');
    expect(target.querySelector('.ss-cascade-target__tag-icon svg')).toHaveAttribute(
      'data-icon-name',
      'ElementDivIcon'
    );
    expect(target.querySelector('.ss-cascade-target__tag')).toHaveTextContent('div');
  });

  it('moves the Add selector action and created rules to the selected display edge', () => {
    const existing = makeRow(1, '.existing');
    const olderCreated = makeRow(1_000_001, '.created-older', {
      sourceOrder: undefined,
      line: 0,
    });
    const newerCreated = makeRow(1_000_002, '.created-newer', {
      sourceOrder: undefined,
      line: 0,
    });
    const rows = [existing, olderCreated, newerCreated];
    const bodies = Object.fromEntries(
      rows.map((row) => [rowKey(row), makeBody(['display', 'grid'])])
    );
    renderPanel(rows, bodies);
    expect(screen.getByRole('button', { name: 'Copy ID' })).toHaveClass('button--icon-only');
    addIncompleteMediaSelector('.hero-draft');

    const panel = screen.getByTestId('css-cascade-panel');
    const list = panel.querySelector<HTMLElement>('.ss-cascade-cards');
    if (!list) throw new Error('Expected the cascade list');
    const header = panel.querySelector<HTMLElement>('.ss-cascade-header');
    const headerMain = panel.querySelector<HTMLElement>('.ss-cascade-header__main');
    const target = panel.querySelector<HTMLElement>('.ss-cascade-target');
    const toolbar = panel.querySelector<HTMLElement>('.ss-cascade-toolbar');
    if (!header || !headerMain || !target || !toolbar)
      throw new Error('Expected the selected-element toolbar');
    expect(target.parentElement).toBe(headerMain);
    expect(toolbar.parentElement).toBe(headerMain);
    expect(target.nextElementSibling).toBe(toolbar);
    const tag = target.querySelector<HTMLElement>('[data-tone="tag"]');
    if (!tag) throw new Error('Expected the selected tag name');
    const copyButton = within(target).getByRole('button', { name: 'Copy ID' });
    expect(tag.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const selector = target.querySelector<HTMLElement>('.ss-cascade-target__selector');
    if (!selector) throw new Error('Expected the selected element classes');
    expect(
      selector.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(copyButton).toHaveAttribute('data-tooltip-content', 'Copy ID & Location: div.hero');

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search CSS rules' }));
    const search = screen.getByRole('searchbox', {
      name: 'Search CSS selectors, properties, and values',
    });
    expect(search).toHaveFocus();
    const searchField = search.closest('.ss-search-field');
    expect(searchField?.parentElement).toBe(header);
    expect(headerMain.nextElementSibling).toBe(searchField);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search CSS rules' })).toHaveFocus();

    const topAddButton = list.querySelector<HTMLElement>(
      ':scope > .ss-cascade-action [data-cascade-add-selector]'
    );
    if (!topAddButton) throw new Error('Expected the top Add selector button');
    expect(topAddButton).toHaveClass('button--fill');
    expect(
      toolbar.compareDocumentPosition(topAddButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const topAdd = list.querySelector(':scope > .ss-cascade-action');
    expect(list.firstElementChild).toBe(topAdd);
    expect(cardOrder(list)).toEqual(['.created-newer', '.created-older', '.existing']);
    expect(list.children[1]).toHaveClass('ss-media-query-group');
    expect(
      list.children[1].querySelector('.ss-media-query-group__selectors')?.lastElementChild
    ).toHaveClass('ss-cascade-action');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'CSS rule order: newest at top. Change to newest at bottom',
      })
    );

    expect(cardOrder(list)).toEqual(['.existing', '.created-older', '.created-newer']);
    expect(list.lastElementChild).toHaveClass('ss-cascade-action');
    const bottomAddButton = list.querySelector<HTMLElement>(
      ':scope > .ss-cascade-action:last-child [data-cascade-add-selector]'
    );
    if (!bottomAddButton) throw new Error('Expected the bottom Add selector button');
    expect(bottomAddButton).toHaveClass('button--fill');
    expect(
      toolbar.compareDocumentPosition(bottomAddButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(list.children[list.children.length - 2]).toHaveClass('ss-media-query-group');
    expect(rows.map((row) => row.sourceOrder)).toEqual([1, undefined, undefined]);
  });

  it('shares the app-global order across mounted panels and restores it after remount', () => {
    const first = renderPanel([], {});
    const second = renderPanel([], {});

    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'CSS rule order: newest at top. Change to newest at bottom',
      })[0]
    );

    expect(
      screen.getAllByRole('button', {
        name: 'CSS rule order: newest at bottom. Change to newest at top',
      })
    ).toHaveLength(2);
    expect(localStorage.getItem(CASCADE_DISPLAY_ORDER_PREFERENCE_KEY)).toBe('1');

    first.unmount();
    second.unmount();
    renderPanel([], {});
    expect(
      screen.getByRole('button', {
        name: 'CSS rule order: newest at bottom. Change to newest at top',
      })
    ).toBeInTheDocument();
  });

  it('filters declaration matches, reveals search results for collapse controls, and restores saved collapse state', () => {
    const root = makeRow(1, '.hero');
    const readonly = makeRow(2, '.hero-readonly', {
      editable: false,
      declarations: [{ prop: 'font-family', value: 'Inter', important: false, active: true }],
    });
    const responsive = makeRow(3, '.hero-responsive', {
      mediaText: '(max-width: 700px)',
      mediaMinPx: null,
    });
    const newDraft = makeRow(4, '.hero-new', { draft: true, line: 0 });
    const rows = [root, readonly, responsive, newDraft];
    const bodies: Record<string, RuleBody> = {
      [rowKey(root)]: {
        items: [
          { kind: 'decl', prop: 'font-family', value: 'Inter', important: false },
          { kind: 'decl', prop: 'display', value: 'grid', important: false },
          {
            kind: 'rule',
            selector: '&:hover',
            body: {
              items: [{ kind: 'decl', prop: 'color', value: 'red', important: false }],
            },
          },
        ],
      },
      [rowKey(responsive)]: makeBody(['font-family', 'Inter']),
      [rowKey(newDraft)]: { items: [] },
    };
    renderPanel(rows, bodies);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse media query' }));
    addIncompleteMediaSelector('.hero-draft');
    fireEvent.click(screen.getByRole('button', { name: 'Search CSS rules' }));
    const search = screen.getByRole('searchbox', {
      name: 'Search CSS selectors, properties, and values',
    });

    fireEvent.change(search, { target: { value: 'font-family' } });
    const panel = screen.getByTestId('css-cascade-panel');
    const rootCard = selectorCard(panel, '.hero');
    expect(within(rootCard).getByText('font-family')).toBeInTheDocument();
    expect(within(rootCard).queryByText('display')).not.toBeInTheDocument();
    expect(selectorCard(panel, '.hero-readonly')).toBeInTheDocument();
    expect(selectorCard(panel, '.hero-responsive')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'hero' } });
    expect(draftMediaGroup(panel)).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-new')).toBeInTheDocument();
    expect(rootCard.querySelector('[data-testid="cascade-card"]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));
    expect(rootCard).toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-readonly')).toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-new')).toHaveClass('is-collapsed');
    expect(draftMediaGroup(panel)).toHaveClass('is-collapsed');

    fireEvent.click(within(rootCard).getByRole('button', { name: 'Expand rule' }));
    const getNestedCard = () => {
      const card = rootCard.querySelector<HTMLElement>('[data-testid="cascade-card"]');
      if (!card) throw new Error('Expected the nested rule card to match search');
      return card;
    };
    expect(getNestedCard()).toHaveClass('is-collapsed');

    fireEvent.click(
      within(draftMediaGroup(panel)).getByRole('button', { name: 'Expand media query' })
    );
    expect(selectorCard(panel, '.hero-draft')).toHaveClass('is-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all CSS selector cards' }));
    expect(rootCard).not.toHaveClass('is-collapsed');
    expect(getNestedCard()).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-readonly')).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-responsive')).not.toHaveClass('is-collapsed');
    expect(draftMediaGroup(panel)).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-draft')).not.toHaveClass('is-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Clear CSS search' }));

    const mediaGroup = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-testid="media-query-group"]')
    ).find((group) => group.textContent?.includes('700px'));
    expect(mediaGroup).toHaveClass('is-collapsed');
    expect(rootCard).not.toHaveClass('is-collapsed');
    expect(getNestedCard()).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-readonly')).not.toHaveClass('is-collapsed');
    expect(draftMediaGroup(panel)).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-draft')).not.toHaveClass('is-collapsed');
  });
});
