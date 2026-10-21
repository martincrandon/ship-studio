import { describe, expect, it } from 'vitest';
import {
  compatibleMarkupTags,
  directTextReason,
  decodeTextEntities,
  encodeDirectTextForSource,
  replaceMarkupTagName,
} from './edit-markup';

describe('replaceMarkupTagName', () => {
  it('changes only the selected pair and preserves nested same-name tags and expressions', () => {
    const source =
      '<div data-note={title.includes(">") ? "yes" : "no"} className={classes}>before<div>inner</div> after</div>';

    expect(replaceMarkupTagName(source, 'div', 'section')).toBe(
      '<section data-note={title.includes(">") ? "yes" : "no"} className={classes}>before<div>inner</div> after</section>'
    );
  });

  it('preserves whitespace, attribute spelling, and quoted greater-than characters', () => {
    const source = `<p title='a > b'  className="copy">Text</p>`;

    expect(replaceMarkupTagName(source, 'p', 'h2')).toBe(
      `<h2 title='a > b'  className="copy">Text</h2>`
    );
  });

  it('refuses a mismatched, self-closing, or unpaired selected element', () => {
    expect(replaceMarkupTagName('<div>Text</div>', 'p', 'span')).toBeNull();
    expect(replaceMarkupTagName('<div />', 'div', 'p')).toBeNull();
    expect(replaceMarkupTagName('<div><span>Text</div>', 'div', 'p')).toBeNull();
  });
});

describe('compatibleMarkupTags', () => {
  it('puts the current text tag first and retains related text alternatives', () => {
    const options = compatibleMarkupTags('<h2>Heading</h2>', 'h2');

    expect(options[0]).toEqual({ tag: 'h2', label: 'H2' });
    expect(options.map(({ tag }) => tag)).toEqual([
      'h2',
      'h1',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'span',
      'div',
      'section',
      'article',
      'nav',
      'header',
      'footer',
      'aside',
      'main',
      'a',
    ]);
  });

  it('offers a link block for ordinary flow content without inventing an href', () => {
    const flowContent = compatibleMarkupTags('<div><div>Details</div></div>', 'div');
    const dynamicHref = compatibleMarkupTags('<div href={productUrl}>Details</div>', 'div');

    expect(flowContent.some(({ tag }) => tag === 'a')).toBe(true);
    expect(dynamicHref.some(({ tag }) => tag === 'a')).toBe(true);
    expect(replaceMarkupTagName('<div><div>Details</div></div>', 'div', 'a')).toBe(
      '<a><div>Details</div></a>'
    );
  });

  it('does not offer a link block when interactive content is nested', () => {
    const options = compatibleMarkupTags(
      '<div href="/products">Details <button type="button">Open</button></div>',
      'div'
    );

    expect(options.some(({ tag }) => tag === 'a')).toBe(false);
    expect(
      compatibleMarkupTags('<div><a href="/">Open</a></div>', 'div').some(({ tag }) => tag === 'a')
    ).toBe(false);
  });

  it('keeps dynamic JSX children out of phrasing and link alternatives', () => {
    const options = compatibleMarkupTags(
      '<div>{items.map((item) => <div>{item}</div>)}</div>',
      'div'
    );

    expect(options.map(({ tag }) => tag)).not.toContain('a');
    expect(options.map(({ tag }) => tag)).not.toContain('p');
    expect(options.map(({ tag }) => tag)).not.toContain('span');
    expect(options.map(({ tag }) => tag)).not.toContain('h1');
  });

  it('does not offer a link block around unknown custom elements', () => {
    const options = compatibleMarkupTags('<div><x-action>Open</x-action></div>', 'div');

    expect(options.map(({ tag }) => tag)).not.toContain('a');
  });

  it('refuses to rewrite capitalized JSX component names as native tags', () => {
    expect(replaceMarkupTagName('<Card>Text</Card>', 'card', 'section')).toBeNull();
    expect(compatibleMarkupTags('<Card>Text</Card>', 'Card')).toHaveLength(1);
  });

  it('does not offer a link block under a restrictive ancestor', () => {
    const options = compatibleMarkupTags('<div><div>Block</div></div>', 'div', ['main', 'p']);

    expect(options.some(({ tag }) => tag === 'a')).toBe(false);
  });

  it('does not offer flow tags inside a nested phrasing context', () => {
    const options = compatibleMarkupTags('<span><span>Label</span></span>', 'span', ['p', 'span']);

    expect(options.some(({ tag }) => tag === 'div' || tag === 'section' || tag === 'p')).toBe(
      false
    );
  });

  it('allows safe semantic container conversions and keeps the current tag first', () => {
    const options = compatibleMarkupTags('<section><div>Body</div></section>', 'section');

    expect(options[0]?.tag).toBe('section');
    expect(options.map(({ tag }) => tag)).toContain('article');
    expect(options.map(({ tag }) => tag)).toContain('main');
  });

  it('retains only the current option for structural children or specialized roots', () => {
    expect(compatibleMarkupTags('<div><li>Item</li></div>', 'div').map(({ tag }) => tag)).toEqual([
      'div',
    ]);
    expect(compatibleMarkupTags('<button>Save</button>', 'button').map(({ tag }) => tag)).toEqual([
      'button',
    ]);
  });
});

describe('direct text guards', () => {
  it('allows direct text and refuses nested markup and dynamic expressions', () => {
    expect(directTextReason('A complete title')).toBeNull();
    expect(directTextReason('A <strong>bold</strong> title')).toContain('nested markup');
    expect(directTextReason('{title}')).toContain('JSX syntax');
  });

  it('decodes rendered entities for display and re-encodes user text for JSX-safe source', () => {
    expect(decodeTextEntities('A &amp; B &copy;')).toBe('A & B ©');
    expect(encodeDirectTextForSource('A & <copy> {title}')).toBe(
      'A &amp; &lt;copy&gt; &#123;title&#125;'
    );
  });
});
