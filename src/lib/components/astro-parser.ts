import * as astroCompiler from '@astrojs/compiler';
import type { DiagnosticMessage, ParseResult } from '@astrojs/compiler/types';
import type { ComponentDiagnostic, SourceFileSnapshot } from './types';

// The package's browser entry is initialized with this Vite-managed asset. In
// Node/Vitest the package uses its own synchronous WASM bootstrap and does not
// expose initialize; the optional capability keeps the same test and worker
// module usable in both environments without importing project tooling.
import astroWasmUrl from '@astrojs/compiler/astro.wasm?url';

export const ASTRO_COMPILER_VERSION = '4.0.0';
export const ASTRO_COMPONENT_PLAN_PARSER_TOKEN = 'astro-component-plan-v1';

type BrowserCompiler = typeof astroCompiler & {
  initialize?: (options: { wasmURL: string }) => Promise<void>;
};

let ready: Promise<void> | null = null;

/** Initialize the browser compiler once per worker. */
export function ensureAstroParser(): Promise<void> {
  const compiler = astroCompiler as BrowserCompiler;
  if (!compiler.initialize) return Promise.resolve();
  ready ??= compiler.initialize({ wasmURL: astroWasmUrl }).catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

/** Parse one complete `.astro` document without loading project code/config. */
export async function parseAstroDocument(source: string): Promise<ParseResult> {
  await ensureAstroParser();
  return astroCompiler.parse(source, { position: true });
}

/** Convert compiler diagnostics into the index's serializable diagnostic DTO. */
export function astroCompilerDiagnostics(
  file: SourceFileSnapshot,
  diagnostics: readonly DiagnosticMessage[]
): ComponentDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    // The enum is intentionally type-only in @astrojs/compiler's browser
    // declarations; normalize its documented numeric values without adding a
    // runtime import that the browser bundle cannot resolve.
    const severity = Number(diagnostic.severity);
    return {
      code: `astro-${diagnostic.code}`,
      severity: severity === 1 ? 'error' : severity === 2 ? 'warning' : 'info',
      message: diagnostic.text,
      file: file.file,
      // The compiler's positions are display metadata. The source scanner and
      // mutation planner remain responsible for exact byte ranges.
      source: undefined,
    };
  });
}

/** Parse and return only actionable compiler diagnostics for one source file. */
export async function validateAstroDocument(
  file: SourceFileSnapshot
): Promise<ComponentDiagnostic[]> {
  const result = await parseAstroDocument(file.content);
  return astroCompilerDiagnostics(file, result.diagnostics).filter(
    (diagnostic) => diagnostic.severity !== 'info'
  );
}
