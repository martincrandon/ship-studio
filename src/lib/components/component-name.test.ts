import { describe, expect, it } from 'vitest';
import { presentedComponentName } from './component-name';

describe('presentedComponentName', () => {
  it.each([
    ['HeroCard', 'Hero Card'],
    ['hero_card', 'Hero Card'],
    ['hero-card', 'Hero Card'],
    ['  hero card  ', 'Hero Card'],
  ])('formats %s as %s', (source, expected) => {
    expect(presentedComponentName(source)).toBe(expected);
  });
});
