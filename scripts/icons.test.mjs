import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  validateAssets,
  validateDeclarations,
  validateDynamicSvg,
} from './icons.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const fixtureRoot = path.join(scriptDirectory, 'fixtures', 'icons');
const fixtureIcons = path.join(fixtureRoot, 'assets', 'icons');
const fixtureGraphics = path.join(fixtureRoot, 'assets', 'graphics');

test('icons:check accepts the checked-in asset tree', () => {
  const output = execFileSync(process.execPath, ['scripts/icons.mjs', 'check'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  assert.match(output, /Icon asset check passed/);
});

test('asset fixtures reject invalid filenames, unsafe markup, and duplicate basenames', () => {
  const result = validateAssets({ iconsDirectory: fixtureIcons, graphicsDirectory: fixtureGraphics });
  const errors = result.errors.join('\n');

  assert.match(errors, /invalid_name\.svg: filename must be lowercase kebab-case/);
  assert.match(errors, /unsafe\.svg: script and foreignObject markup is not allowed/);
  assert.match(errors, /unsafe\.svg: inline event attributes are not allowed/);
  assert.match(errors, /duplicate\.svg: duplicate SVG basename/);
});

test('archived icons are still validated but do not reserve active asset basenames', (t) => {
  const archivedIcons = path.join(fixtureIcons, 'old-icons');
  fs.mkdirSync(archivedIcons, { recursive: true });
  t.after(() => fs.rmSync(archivedIcons, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(archivedIcons, 'duplicate.svg'),
    '<svg viewBox="0 0 1 1"><path d="M0 0" /></svg>'
  );
  fs.writeFileSync(
    path.join(archivedIcons, 'unsafe.svg'),
    '<svg viewBox="0 0 1 1"><script /></svg>'
  );

  const result = validateAssets({ iconsDirectory: fixtureIcons, graphicsDirectory: fixtureGraphics });
  const errors = result.errors.join('\n');
  assert.doesNotMatch(errors, /old-icons\/duplicate\.svg: duplicate SVG basename/);
  assert.match(errors, /old-icons\/unsafe\.svg: script and foreignObject markup is not allowed/);
});

test('metadata fixtures reject missing sources and duplicate names', () => {
  const assetInfo = validateAssets({ iconsDirectory: fixtureIcons, graphicsDirectory: fixtureGraphics });
  const result = validateDeclarations(assetInfo, {
    componentDirectory: path.join(fixtureRoot, 'components', 'icons'),
    indexFile: path.join(fixtureRoot, 'components', 'icons', 'index.tsx'),
    iconsDirectory: fixtureIcons,
  });
  const errors = result.errors.join('\n');

  assert.match(errors, /MissingSourceIcon: source does not exist/);
  assert.match(errors, /duplicate icon metadata name: DuplicateIcon/);
});

test('inline SVG fixtures reject unmarked static markup', () => {
  const errors = validateDynamicSvg({
    sourceDirectory: path.join(fixtureRoot, 'components'),
    branchFile: path.join(fixtureRoot, 'components', 'branches', 'BranchGraph.tsx'),
  });

  assert.match(errors.join('\n'), /NotAllowed\.tsx: static inline SVG is not allowed/);
});
