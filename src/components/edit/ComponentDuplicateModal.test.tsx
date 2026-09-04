import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentCapabilities, ComponentDescriptor } from '../../lib/components/types';
import { ComponentDuplicateModal } from './ComponentDuplicateModal';

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
  focusedVisualEditing: true,
  duplicateDefinition: true,
  renameDefinition: false,
  deleteDefinition: false,
  extract: false,
  isolatedPreview: false,
};

const component: ComponentDescriptor = {
  id: 'react:components/Header.tsx#default',
  dialect: 'react',
  kind: 'component',
  name: 'Header',
  localName: 'Header',
  exportName: 'default',
  description: null,
  definition: {
    file: 'components/Header.tsx',
    start: 0,
    end: 20,
    line: 1,
    column: 1,
    contentHash: 'header-hash',
  },
  props: [],
  slots: [],
  variantProps: [],
  usageCount: 1,
  capabilities,
  diagnostics: [],
};

describe('ComponentDuplicateModal', () => {
  it('requires an explicit destination and forwards the duplicate request', () => {
    const onDuplicate = vi.fn();
    render(
      <ComponentDuplicateModal
        component={component}
        isOpen
        onClose={vi.fn()}
        onDuplicate={onDuplicate}
      />
    );

    expect(screen.getByDisplayValue('HeaderCopy')).toBeInTheDocument();
    expect(screen.getByDisplayValue('components/HeaderCopy.tsx')).toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: 'New component name' });
    const destination = screen.getByRole('textbox', { name: 'Destination file' });
    fireEvent.change(name, { target: { value: 'NavWrap' } });
    fireEvent.change(destination, { target: { value: 'components/NavWrap.tsx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review duplicate' }));

    expect(onDuplicate).toHaveBeenCalledWith({
      componentId: component.id,
      newName: 'NavWrap',
      destinationFile: 'components/NavWrap.tsx',
    });
  });
});
