import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalStorageFlag } from './useLocalStorageFlag';

const key = 'test:shared-local-storage-flag';

function Consumer({ name }: { name: string }) {
  const [enabled, , toggle] = useLocalStorageFlag(key, false);
  return (
    <button type="button" onClick={toggle}>
      {name}: {enabled ? 'enabled' : 'disabled'}
    </button>
  );
}

beforeEach(() => localStorage.removeItem(key));
afterEach(() => {
  localStorage.removeItem(key);
  vi.restoreAllMocks();
});

describe('useLocalStorageFlag', () => {
  it('synchronizes mounted consumers and restores the app-global value after remount', () => {
    const view = render(
      <StrictMode>
        <Consumer name="Project A" />
        <Consumer name="Project B" />
      </StrictMode>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Project A: disabled' }));

    expect(screen.getByRole('button', { name: 'Project A: enabled' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project B: enabled' })).toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe('1');

    view.unmount();
    render(<Consumer name="Project C" />);
    expect(screen.getByRole('button', { name: 'Project C: enabled' })).toBeInTheDocument();
  });

  it('uses same-window updates when persistence is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage disabled');
    });
    render(
      <>
        <Consumer name="Project A" />
        <Consumer name="Project B" />
      </>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Project A: disabled' }));

    expect(screen.getByRole('button', { name: 'Project A: enabled' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project B: enabled' })).toBeInTheDocument();
  });

  it('syncs another tab storage events', () => {
    render(<Consumer name="Project B" />);
    localStorage.setItem(key, '1');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key, newValue: '1', storageArea: localStorage })
      );
    });

    expect(screen.getByRole('button', { name: 'Project B: enabled' })).toBeInTheDocument();
  });
});
