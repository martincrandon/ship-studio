/**
 * Compact workspace top bar.
 *
 * Self-contained. Static layout and visual states live in the compact-workspace
 * stylesheet; React retains only the platform modifier and behavior state for
 * pinning and project-menu mounting.
 *
 * @module components/CompactTopbar
 */

import { useCallback, useState } from 'react';
import { PinIcon, ChevronIcon } from '@/components/icons';
import { useOpenPalette } from '../CommandPalette/paletteContext';
import { setAlwaysOnTop } from '../../lib/window';
import { logger } from '../../lib/logger';
import { isMac } from '../../lib/setup';
import { kbd } from '../../lib/shortcuts';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';

interface Props {
  projectLabel: string;
  hasDevServer: boolean;
  switchableProjects: PinnedProjectRow[];
  onSelectProject: (projectPath: string) => void;
  onGoHome: () => void;
}

// The platform modifier preserves the macOS traffic-light inset without
// keeping static layout declarations in React style objects.
const topbarPlatformClass = isMac() ? 'compact-topbar--mac' : 'compact-topbar--native';

export function CompactTopbar({
  projectLabel,
  hasDevServer,
  switchableProjects,
  onSelectProject,
  onGoHome,
}: Props) {
  const openPalette = useOpenPalette();
  const openProjectPalette = useCallback(() => openPalette({ tab: 'project' }), [openPalette]);
  const openAllPalette = useCallback(() => openPalette(), [openPalette]);

  const [isPinned, setIsPinned] = useState(false);
  const togglePin = useCallback(() => {
    const next = !isPinned;
    setIsPinned(next);
    setAlwaysOnTop(next).catch((error) => {
      logger.error('Failed to toggle always on top', { error });
      setIsPinned(!next);
    });
  }, [isPinned]);

  // React state controls whether the project menu is mounted; CSS owns its
  // static layout and the visual hover/focus treatments.
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className={`compact-topbar ${topbarPlatformClass}`}>
      <div className="compact-topbar__spacer" aria-hidden="true" />
      <div className="compact-topbar__actions">
        {hasDevServer && (
          <span className="compact-topbar__dev-server" aria-label="Dev server running">
            <span className="compact-topbar__dev-server-dot" />
          </span>
        )}
        <button
          type="button"
          className={`compact-topbar__icon-button${isPinned ? ' is-pinned' : ''}`}
          onClick={togglePin}
          aria-pressed={isPinned}
          title={isPinned ? 'Unpin window' : 'Pin window on top'}
          aria-label={isPinned ? 'Unpin window' : 'Pin window on top'}
        >
          <PinIcon size={12} />
        </button>
        <button
          type="button"
          className="compact-topbar__palette-button"
          onClick={openAllPalette}
          title="Open command palette"
          aria-label="Open command palette"
        >
          {kbd('mod', 'K')}
        </button>
        <div
          className="compact-topbar__project-picker"
          onMouseEnter={() => setMenuOpen(true)}
          onMouseLeave={() => setMenuOpen(false)}
        >
          <button
            type="button"
            className="compact-topbar__project-button"
            onClick={openProjectPalette}
            title={`Switch project (currently ${projectLabel})`}
            aria-label={`Switch project (currently ${projectLabel})`}
          >
            <span className="compact-topbar__project-label">{projectLabel}</span>
            <ChevronIcon size={10} />
          </button>
          {menuOpen && switchableProjects.length > 0 && (
            <div role="menu" className="compact-topbar-project-menu">
              <button type="button" className="compact-topbar-project-menu-item" onClick={onGoHome}>
                Home
              </button>
              {switchableProjects.map((row) => (
                <button
                  key={row.projectPath}
                  type="button"
                  className="compact-topbar-project-menu-item"
                  onClick={() => onSelectProject(row.projectPath)}
                >
                  {row.fallbackName}
                </button>
              ))}
              <div className="compact-topbar-project-menu-divider" />
              <button
                type="button"
                className="compact-topbar-project-menu-item is-subtle"
                onClick={openProjectPalette}
              >
                All projects…
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
