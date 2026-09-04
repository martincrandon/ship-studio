import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentRefactorPreview } from '../../lib/components/types';
import { ComponentRefactorReviewModal } from './ComponentRefactorReviewModal';

const preview: ComponentRefactorPreview = {
  operation: 'duplicate',
  affectedFiles: ['components/NavWrap.tsx'],
  files: [
    {
      file: 'components/NavWrap.tsx',
      operation: 'create',
      beforeHash: null,
      afterHash: 'result-hash',
      after: 'export default function NavWrap() { return <nav />; }',
    },
  ],
  graphDelta: {
    componentId: 'react:components/Header.tsx#default',
    usagesBefore: 1,
    usagesAfter: 1,
    delta: 0,
    createdComponentId: 'react:components/NavWrap.tsx#default',
    createdUsages: 0,
  },
};

describe('ComponentRefactorReviewModal', () => {
  it('shows the complete new file before confirming creation', () => {
    render(
      <ComponentRefactorReviewModal preview={preview} onCancel={vi.fn()} onConfirm={vi.fn()} />
    );

    expect(screen.getByRole('dialog', { name: 'Review component duplicate' })).toBeInTheDocument();
    expect(
      screen.getByText('+export default function NavWrap() { return <nav />; }')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create component' })).toBeInTheDocument();
  });
});
