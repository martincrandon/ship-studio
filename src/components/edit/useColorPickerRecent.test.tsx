import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useColorPickerRecent } from './useColorPickerRecent';

function RecentHistory({ projectPath }: { projectPath: string }) {
  const { colors, recordColor } = useColorPickerRecent(projectPath);
  const samples = Array.from(
    { length: 10 },
    (_, index) => `#${(index + 1).toString(16).padStart(6, '0')}`
  );

  return (
    <div>
      <output aria-label="Recent colors">{JSON.stringify(colors)}</output>
      {samples.map((color) => (
        <button key={color} onClick={() => recordColor(color)}>
          Record {color}
        </button>
      ))}
      <button onClick={() => recordColor('rgb(0, 0, 1)')}>Record equivalent first color</button>
    </div>
  );
}

describe('useColorPickerRecent', () => {
  it('deduplicates and bounds history separately for each project', () => {
    window.localStorage.removeItem('shipstudio.color-picker.recent.v1:%2Fprojects%2Falpha');
    window.localStorage.removeItem('shipstudio.color-picker.recent.v1:%2Fprojects%2Fbeta');
    const { rerender } = render(<RecentHistory projectPath="/projects/alpha" />);
    const colors = Array.from(
      { length: 10 },
      (_, index) => `#${(index + 1).toString(16).padStart(6, '0')}`
    );
    colors.forEach((color) =>
      fireEvent.click(screen.getByRole('button', { name: `Record ${color}` }))
    );

    const alphaHistory = JSON.parse(
      screen.getByLabelText('Recent colors').textContent ?? '[]'
    ) as string[];
    expect(alphaHistory).toHaveLength(9);
    expect(alphaHistory[0]).toBe('rgb(0, 0, 10)');
    expect(alphaHistory).not.toContain('rgb(0, 0, 1)');

    fireEvent.click(screen.getByRole('button', { name: 'Record #000001' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record equivalent first color' }));
    const deduplicated = JSON.parse(
      screen.getByLabelText('Recent colors').textContent ?? '[]'
    ) as string[];
    expect(deduplicated).toHaveLength(9);
    expect(deduplicated[0]).toBe('rgb(0, 0, 1)');
    expect(deduplicated.filter((color) => color === 'rgb(0, 0, 1)')).toHaveLength(1);

    rerender(<RecentHistory projectPath="/projects/beta" />);
    expect(screen.getByLabelText('Recent colors')).toHaveTextContent('[]');

    rerender(<RecentHistory projectPath="/projects/alpha" />);
    const restored = JSON.parse(
      screen.getByLabelText('Recent colors').textContent ?? '[]'
    ) as string[];
    expect(restored).toEqual(deduplicated);
  });
});
