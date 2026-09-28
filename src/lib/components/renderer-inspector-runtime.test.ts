import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRendererInspectorRuntimeSource } from './renderer-inspector-runtime';

type Runtime = {
  setPost: (post: (type: string, extra?: Record<string, unknown>) => void) => void;
  start: (root: Element) => void;
  send: (root: Element) => void;
  select: (domRoot: Element, metadataRoot: Record<string, unknown>, element: Element) => void;
  hover: (root: Element | null, target: Element | null) => void;
  reselect: (
    domRoot: Element,
    metadataRoot: Record<string, unknown>,
    signature: Record<string, unknown>
  ) => void;
  clear: () => void;
  destroy: () => void;
};

function createRuntime(): Runtime {
  const compiled = ts.transpileModule(
    `${buildRendererInspectorRuntimeSource()}
return {
  setPost: (post) => { inspectorPost = post; },
  start: inspectorTreeStart,
  send: inspectorTreeSend,
  select: inspectorSelect,
  hover: inspectorHover,
  reselect: inspectorReselect,
  clear: () => { if (inspectorSelectedRef.current) inspectorClearClassPreview(inspectorSelectedRef.current); },
  destroy: inspectorDestroy,
};`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 } }
  ).outputText;

  return new Function(compiled)() as Runtime;
}

function metadataRoot(): Record<string, unknown> {
  return {
    tag: 'article',
    classTokens: ['card'],
    id: null,
    source: {
      file: 'src/components/Card.tsx',
      start: 10,
      end: 42,
      line: 2,
      column: 3,
      contentHash: 'card-hash',
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('renderer inspector runtime', () => {
  it('fails closed for stale paths and only falls back for an unambiguous path-less signature', () => {
    const runtime = createRuntime();
    const messages: Array<{ type: string; extra: Record<string, unknown> }> = [];
    runtime.setPost((type, extra = {}) => messages.push({ type, extra }));
    const root = document.createElement('article');
    root.className = 'card';
    root.innerHTML = '<button class="cta">First</button><button class="cta">Second</button>';
    document.body.append(root);
    runtime.start(root);
    runtime.send(root);

    runtime.reselect(root, metadataRoot(), {
      domPath: 'article:0>button:999',
      tagName: 'button',
      className: 'cta',
    });
    expect(messages.filter((message) => message.type === 'ss:select')).toHaveLength(0);

    runtime.reselect(root, metadataRoot(), { tagName: 'button', className: 'cta' });
    expect(messages.filter((message) => message.type === 'ss:select')).toHaveLength(0);

    root.lastElementChild?.remove();
    runtime.reselect(root, metadataRoot(), { tagName: 'button', className: 'cta' });
    expect(messages.filter((message) => message.type === 'ss:select')).toHaveLength(1);
    runtime.destroy();
  });

  it('keys class-preview baselines to the selected element and restores them on cleanup', () => {
    const runtime = createRuntime();
    const root = document.createElement('article');
    root.className = 'card';
    const first = document.createElement('button');
    first.className = 'first';
    const second = document.createElement('button');
    second.className = 'second';
    root.append(first, second);
    document.body.append(root);

    runtime.select(root, metadataRoot(), first);
    first.className = 'first preview';
    runtime.select(root, metadataRoot(), second);
    expect(first.className).toBe('first');

    second.className = 'second preview';
    runtime.clear();
    expect(second.className).toBe('second');

    runtime.select(root, metadataRoot(), first);
    first.className = 'first preview';
    runtime.destroy();
    expect(first.className).toBe('first');
  });

  it('uses the same blue hover and selection overlays as the regular Preview', () => {
    const runtime = createRuntime();
    const root = document.createElement('article');
    const child = document.createElement('button');
    root.append(child);
    document.body.append(root);

    runtime.hover(root, child);
    const hoverOverlay = document.querySelector<HTMLDivElement>('[data-ss-overlay="hover"]');
    expect(hoverOverlay).not.toBeNull();
    expect(hoverOverlay?.style.borderWidth).toBe('1.5px');
    expect(hoverOverlay?.style.borderStyle).toBe('solid');
    expect(hoverOverlay?.style.borderColor).toBe('rgb(0, 125, 240)');

    runtime.select(root, metadataRoot(), child);
    const selectionOverlay = document.querySelector<HTMLDivElement>(
      '[data-ss-overlay="selection"]'
    );
    expect(selectionOverlay).not.toBeNull();
    expect(selectionOverlay?.style.borderWidth).toBe('1.5px');
    expect(selectionOverlay?.style.borderStyle).toBe('solid');
    expect(selectionOverlay?.style.borderColor).toBe('rgba(0, 125, 240, 0.95)');
  });
});
