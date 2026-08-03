import { useState, type ComponentType } from 'react';
import * as iconLibrary from './index';
import inventory from './icon-inventory.json';

interface GalleryIconProps {
  size?: number;
}

/**
 * Opt-in visual inventory for migration work. Open the app with
 * `?iconGallery=1` to compare every tracked icon and its provenance in one
 * scrollable surface without changing the normal app chrome.
 */
export function IconAuditGallery() {
  const [open, setOpen] = useState(true);
  const enabled = new URLSearchParams(window.location.search).get('iconGallery') === '1';

  if (!enabled || !open) return null;

  return (
    <aside className="icon-audit-gallery" aria-label="Icon migration gallery">
      <header className="icon-audit-gallery__header">
        <div>
          <strong>Icon migration gallery</strong>
          <span>{inventory.icons.length} tracked definitions</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close icon gallery">
          Close
        </button>
      </header>
      <div className="icon-audit-gallery__legend" aria-hidden="true">
        <span data-status="new-design">New design</span>
        <span data-status="legacy">Legacy</span>
        <span data-status="not-applicable">Brand/system</span>
      </div>
      <div className="icon-audit-gallery__grid">
        {inventory.icons.map((entry) => {
          const Icon = iconLibrary[entry.name as keyof typeof iconLibrary] as
            | ComponentType<GalleryIconProps>
            | undefined;
          if (!Icon) return null;

          return (
            <div className="icon-audit-gallery__item" data-status={entry.status} key={entry.name}>
              <div className="icon-audit-gallery__glyph">
                <Icon size={24} />
              </div>
              <span className="icon-audit-gallery__name">{entry.name}</span>
              <span className="icon-audit-gallery__source">
                {entry.source ?? (entry.status === 'legacy' ? 'legacy source' : 'brand/system')}
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
