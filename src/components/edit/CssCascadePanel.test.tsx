import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CssCascadePanel } from './CssCascadePanel';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { CascadeRow } from '../../lib/cssCascade';
import type { useCssAnimations } from '../../hooks/useCssAnimations';

const row: CascadeRow = {
  index: 0,
  selector: '.card',
  declarations: [{ prop: 'color', value: 'red', important: false, active: true }],
  specificity: [0, 1, 0],
  mediaText: null,
  mediaMinPx: null,
  inactiveMedia: false,
  layer: null,
  origin: 'author',
  editable: true,
  file: 'styles.css',
  line: 1,
  innerText: 'color: red;',
};

const selection = {
  signature: { tagName: 'div', className: 'card', ancestorClasses: [] },
  instanceCount: 1,
};

const settings: ElementSettings = {
  tag: 'div',
  classes: ['card'],
  attributes: [],
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

const animationsState = {
  animations: [],
  loading: false,
  reload: vi.fn(),
  setBody: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
} as unknown as ReturnType<typeof useCssAnimations>;

function renderPanel(readOnly = true) {
  return render(
    <CssCascadePanel
      selection={selection}
      rows={[row]}
      loading={false}
      bodies={{ '0:.card': { items: [] } }}
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
      settings={settings}
      animationsState={animationsState}
      onClose={vi.fn()}
      readOnly={readOnly}
      readOnlyReason="The selected child source range is not proven."
    />
  );
}

describe('CssCascadePanel read-only mode', () => {
  it('keeps cascade data visible while disabling mutation affordances', () => {
    renderPanel();

    expect(screen.getByTestId('css-cascade-panel')).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByTestId('css-cascade-readonly-reason')).toHaveTextContent(
      'The selected child source range is not proven.'
    );
    expect(screen.getByText('color')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add selector' })).toBeDisabled();
  });
});
