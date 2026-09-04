import { describe, expect, it } from 'vitest';
import { astroCompilerDiagnostics, parseAstroDocument } from './astro-parser';
import { sha256 } from './ranges';

describe('Astro compiler worker boundary', () => {
  it('parses a valid document through the bundled compiler/WASM runtime', async () => {
    const content = `---\ninterface Props { title: string }\n---\n<section><h1>{Astro.props.title}</h1></section>\n`;
    const result = await parseAstroDocument(content);
    expect(result.diagnostics).toEqual([]);
    expect(result.ast.type).toBe('root');
    expect(result.ast.children.some((node) => node.type === 'element')).toBe(true);
  });

  it('returns structured source metadata for a document with dynamic syntax', async () => {
    const content = `---\nconst title = getTitle();\n---\n<section class:list={title}><span>{title}</span></section>`;
    const file = { file: 'src/components/Card.astro', content, contentHash: sha256(content) };
    const result = await parseAstroDocument(content);
    const diagnostics = astroCompilerDiagnostics(file, result.diagnostics);
    expect(diagnostics).toEqual([]);
    expect(result.ast.children.some((node) => node.type === 'element')).toBe(true);
  });
});
