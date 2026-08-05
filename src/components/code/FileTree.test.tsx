import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FileTreeNode } from '../../lib/code';
import { FileTree } from './FileTree';

const directory: FileTreeNode = {
  name: 'src',
  path: 'src',
  isDirectory: true,
  size: 0,
  children: [
    {
      name: 'App.tsx',
      path: 'src/App.tsx',
      isDirectory: false,
      size: 12,
      children: [],
    },
  ],
};

describe('FileTree', () => {
  it('toggles a collapsed directory when its row is activated', () => {
    const onToggleDirectory = vi.fn();

    render(
      <FileTree
        nodes={[directory]}
        expandedPaths={new Set()}
        selectedFilePath={null}
        onToggleDirectory={onToggleDirectory}
        onSelectFile={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));

    expect(onToggleDirectory).toHaveBeenCalledWith('src');
  });

  it('selects a file when its row is activated', () => {
    const onSelectFile = vi.fn();

    render(
      <FileTree
        nodes={[directory]}
        expandedPaths={new Set(['src'])}
        selectedFilePath={null}
        onToggleDirectory={vi.fn()}
        onSelectFile={onSelectFile}
      />
    );

    fireEvent.click(screen.getByRole('treeitem', { name: 'App.tsx' }));

    expect(onSelectFile).toHaveBeenCalledWith('src/App.tsx');
  });
});
