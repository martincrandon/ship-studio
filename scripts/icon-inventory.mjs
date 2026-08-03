#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconRoot = path.join(projectRoot, 'src/components/icons');
const assetRoot = path.join(iconRoot, 'assets/new-design');
const inventoryPath = path.join(iconRoot, 'icon-inventory.json');
const inlineBaselinePath = path.join(iconRoot, 'inline-svg-baseline.json');
const inlineReviewPath = path.join(iconRoot, 'inline-svg-review.json');
const suppliedReviewPath = path.join(iconRoot, 'supplied-asset-review.json');
const sourceRoot = path.join(projectRoot, 'src');

const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const entries = inventory.icons;
const inlineReview = fs.existsSync(inlineReviewPath)
  ? JSON.parse(fs.readFileSync(inlineReviewPath, 'utf8'))
  : { files: [] };
const suppliedReview = fs.existsSync(suppliedReviewPath)
  ? JSON.parse(fs.readFileSync(suppliedReviewPath, 'utf8'))
  : { assets: [] };
const inlineReviewByPath = new Map(inlineReview.files.map((entry) => [entry.path, entry]));
const validInlineDispositions = new Set(['intentional-graphic', 'reserved', 'needs-confirmation']);
const validStatuses = new Set(['new-design', 'legacy', 'not-applicable']);
const validKinds = new Set(['ui', 'brand', 'system-graphic']);

function walk(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute, extension);
    return entry.name.endsWith(extension) ? [absolute] : [];
  });
}

function relative(file) {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}

function countMatches(source, expression) {
  return [...source.matchAll(expression)].length;
}

function inlineSvgCounts() {
  return walk(sourceRoot, '.tsx')
    .filter((file) => !file.startsWith(iconRoot) && !file.endsWith('.test.tsx'))
    .map((file) => ({
      path: relative(file),
      count: countMatches(fs.readFileSync(file, 'utf8'), /<svg\b/g),
      classification: inlineReviewByPath.get(relative(file))?.disposition ?? 'unclassified',
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function exportedIcons() {
  return walk(iconRoot, '.tsx')
    .filter((file) => !file.endsWith('new-design.tsx') && !file.endsWith('index.tsx'))
    .flatMap((file) =>
      [...fs.readFileSync(file, 'utf8').matchAll(/export function (\w+Icon)\b/g)].map(
        (match) => match[1]
      )
    )
    .sort();
}

function usageLocations(iconName) {
  const expression = new RegExp(`<(?:${iconName})\\b`, 'g');
  return walk(sourceRoot, '.tsx')
    .filter((file) => !file.startsWith(iconRoot))
    .reduce((total, file) => {
      const source = fs.readFileSync(file, 'utf8');
      const iconImports = [
        ...source.matchAll(/import\s*{([^}]*)}\s*from\s*['"][^'"]*\/icons(?:\/[^'"]*)?['"]/g),
      ];
      const importsIcon = iconImports.some((match) =>
        match[1]
          .split(',')
          .map((specifier) => specifier.trim().split(/\s+as\s+/)[0])
          .includes(iconName)
      );
      return total + (importsIcon ? countMatches(source, expression) : 0);
    }, 0);
}

function validate() {
  const errors = [];
  const names = entries.map((entry) => entry.name);
  const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicateNames.length)
    errors.push(`Duplicate inventory entries: ${duplicateNames.join(', ')}`);

  for (const entry of entries) {
    if (!validStatuses.has(entry.status))
      errors.push(`${entry.name}: invalid status ${entry.status}`);
    if (!validKinds.has(entry.kind)) errors.push(`${entry.name}: invalid kind ${entry.kind}`);
    if (entry.status === 'new-design' && !entry.source) {
      errors.push(`${entry.name}: new-design icons require a source SVG`);
    }
    if (entry.source && !fs.existsSync(path.join(assetRoot, entry.source))) {
      errors.push(`${entry.name}: source SVG does not exist: ${entry.source}`);
    }
  }

  const exports = exportedIcons();
  const inventoryNames = [...new Set(names)].sort();
  const missingFromInventory = exports.filter((name) => !inventoryNames.includes(name));
  const missingExport = inventoryNames.filter((name) => !exports.includes(name));
  if (missingFromInventory.length) {
    errors.push(`Exported icons missing from inventory: ${missingFromInventory.join(', ')}`);
  }
  if (missingExport.length) {
    errors.push(`Inventory icons missing an export: ${missingExport.join(', ')}`);
  }

  if (!fs.existsSync(inlineBaselinePath)) {
    errors.push('Missing inline SVG baseline; run pnpm icons:baseline');
  } else {
    const baseline = JSON.parse(fs.readFileSync(inlineBaselinePath, 'utf8'));
    const allowedByPath = new Map(baseline.files.map((entry) => [entry.path, entry.count]));
    for (const entry of inlineSvgCounts()) {
      const allowed = allowedByPath.get(entry.path) ?? 0;
      if (entry.count > allowed) {
        errors.push(
          `${entry.path}: ${entry.count} inline SVGs, baseline allows ${allowed}; use a tracked icon or intentionally update the baseline`
        );
      }
    }
  }

  if (!fs.existsSync(inlineReviewPath)) {
    errors.push(
      'Missing inline SVG review; add dispositions before introducing or retaining raw SVGs'
    );
  } else {
    const current = inlineSvgCounts();
    const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
    for (const entry of current) {
      const review = inlineReviewByPath.get(entry.path);
      if (!review) {
        errors.push(`${entry.path}: missing inline SVG review disposition`);
      } else if (!validInlineDispositions.has(review.disposition)) {
        errors.push(`${entry.path}: invalid inline SVG disposition ${review.disposition}`);
      } else if (review.count !== entry.count) {
        errors.push(
          `${entry.path}: review records ${review.count} inline SVGs, but the file contains ${entry.count}`
        );
      }
    }
    for (const entry of inlineReview.files) {
      if (!currentByPath.has(entry.path)) {
        errors.push(`${entry.path}: inline SVG review entry is stale`);
      }
    }
  }

  if (!fs.existsSync(suppliedReviewPath)) {
    errors.push('Missing supplied asset review; record why unmapped assets remain reserved');
  } else {
    const supplied = new Set(fs.readdirSync(assetRoot).filter((name) => name.endsWith('.svg')));
    const reviewed = suppliedReview.assets.map((entry) => entry.asset);
    const duplicateAssets = reviewed.filter((asset, index) => reviewed.indexOf(asset) !== index);
    if (duplicateAssets.length) {
      errors.push(`Duplicate supplied asset review entries: ${duplicateAssets.join(', ')}`);
    }
    for (const entry of suppliedReview.assets) {
      if (!supplied.has(entry.asset)) {
        errors.push(`Supplied asset review references missing SVG: ${entry.asset}`);
      }
      if (!['reserved', 'needs-confirmation'].includes(entry.disposition)) {
        errors.push(`${entry.asset}: invalid supplied asset disposition ${entry.disposition}`);
      }
    }
  }

  return errors;
}

function printStatus() {
  const uiEntries = entries.filter((entry) => entry.kind === 'ui');
  const newUi = uiEntries.filter((entry) => entry.status === 'new-design');
  const legacyUi = uiEntries.filter((entry) => entry.status === 'legacy');
  const brandEntries = entries.filter((entry) => entry.kind === 'brand');
  const inlineEntries = inlineSvgCounts();
  const inlineCount = inlineEntries.reduce((total, entry) => total + entry.count, 0);
  const inlineByDisposition = inlineEntries.reduce((counts, entry) => {
    counts[entry.classification] = (counts[entry.classification] ?? 0) + entry.count;
    return counts;
  }, {});
  const usageCount = legacyUi.reduce((total, entry) => total + usageLocations(entry.name), 0);
  const supplied = fs
    .readdirSync(assetRoot)
    .filter((name) => name.endsWith('.svg'))
    .sort();
  const mappedSources = new Set(entries.map((entry) => entry.source).filter(Boolean));
  const unmapped = supplied.filter((name) => !mappedSources.has(name));
  const progress = uiEntries.length ? Math.round((newUi.length / uiEntries.length) * 100) : 0;

  console.log('Ship Studio icon migration');
  console.log('');
  console.log(`Tracked UI definitions:       ${uiEntries.length}`);
  console.log(`New design:                  ${newUi.length}`);
  console.log(`Legacy definitions:          ${legacyUi.length}`);
  console.log(`Legacy rendered usages:      ${usageCount}`);
  console.log(`Shared UI migration:         ${progress}%`);
  console.log(`Brand definitions:           ${brandEntries.length}`);
  console.log(`Raw inline SVGs:             ${inlineCount} in ${inlineEntries.length} files`);
  console.log(
    `Inline review:               ${Object.entries(inlineByDisposition)
      .map(([classification, count]) => `${classification} ${count}`)
      .join(', ')}`
  );
  console.log(`Supplied SVGs:               ${supplied.length}`);
  console.log(`Supplied SVGs not mapped:    ${unmapped.length}`);

  console.log('\nLegacy shared icons:');
  console.log(legacyUi.map((entry) => entry.name).join(', '));
  console.log('\nUnmapped supplied SVGs:');
  console.log(unmapped.join(', '));
  const reviewedSupplied = suppliedReview.assets.filter((entry) => unmapped.includes(entry.asset));
  console.log('\nSupplied asset review:');
  console.log(
    reviewedSupplied.length
      ? reviewedSupplied.map((entry) => `${entry.asset} (${entry.disposition})`).join(', ')
      : 'No outstanding supplied assets have been reviewed.'
  );
}

const command = process.argv[2] ?? 'status';

if (command === 'baseline') {
  fs.writeFileSync(
    inlineBaselinePath,
    `${JSON.stringify({ schemaVersion: 1, files: inlineSvgCounts() }, null, 2)}\n`
  );
  console.log(`Wrote ${relative(inlineBaselinePath)}`);
} else if (command === 'check') {
  const errors = validate();
  if (errors.length) {
    console.error('Icon inventory check failed:\n');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log('Icon inventory check passed.');
} else if (command === 'status') {
  printStatus();
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
