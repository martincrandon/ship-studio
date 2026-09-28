import { describe, expect, it } from 'vitest';
import { componentRendererEditingEnabled, componentRendererStageEnabled } from './feature-flags';

describe('component renderer release gates', () => {
  it('keeps editing disabled when the editing flag is off', () => {
    expect(componentRendererEditingEnabled({ editing: false }, true)).toBe(false);
  });

  it('requires both the editing flag and renderer inspector proof', () => {
    expect(componentRendererEditingEnabled({ editing: true }, false)).toBe(false);
    expect(componentRendererEditingEnabled({ editing: true }, true)).toBe(true);
  });

  it('limits the shared stage to the reviewed next-host-v2 contract', () => {
    expect(componentRendererStageEnabled({ stage: true }, 'next-host-v2')).toBe(true);
    expect(componentRendererStageEnabled({ stage: true }, 'next-host-v1')).toBe(false);
    expect(componentRendererStageEnabled({ stage: false }, 'next-host-v2')).toBe(false);
  });
});
