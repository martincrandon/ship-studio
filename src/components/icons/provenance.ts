import type { SVGAttributes } from 'react';
import inventory from './icon-inventory.json';

export type IconStatus = 'new-design' | 'legacy' | 'not-applicable';
export type IconKind = 'ui' | 'brand' | 'system-graphic';

/** Shared rendered SVG stroke width. */
export const ICON_STROKE_WIDTH = '1px';

/**
 * Apply the shared UI sizing policy to icon dimensions.
 *
 * Standard icons are 16px and compact actions are 14px. Keeping this at the
 * shared boundary also updates call sites that still pass the previous 14px
 * or 12px values explicitly.
 */
export function resolveIconSize(size: number, compact = false): number {
  if (compact && (size === 12 || size === 14)) return 14;
  if (size === 14) return 16;
  if (size === 12) return 14;
  return size;
}

interface IconInventoryEntry {
  name: string;
  status: IconStatus;
  kind: IconKind;
  source?: string;
}

const entries = inventory.icons as IconInventoryEntry[];
const inventoryByName = new Map(entries.map((entry) => [entry.name, entry]));

const auditMode = new URLSearchParams(window.location.search).get('iconAudit');
if (
  auditMode === 'all' ||
  auditMode === 'legacy' ||
  auditMode === 'new-design' ||
  auditMode === 'untracked'
) {
  document.documentElement.dataset.iconAudit = auditMode;
}

export function getIconData(name: string): SVGAttributes<SVGSVGElement> {
  const entry = inventoryByName.get(name);
  if (!entry) {
    return {
      'data-icon-name': name,
      'data-icon-provenance': 'untracked',
      'aria-hidden': true,
    } as SVGAttributes<SVGSVGElement>;
  }

  return {
    'data-icon-name': name,
    'data-icon-provenance': entry.status,
    'data-icon-kind': entry.kind,
    'aria-hidden': true,
  } as SVGAttributes<SVGSVGElement>;
}
