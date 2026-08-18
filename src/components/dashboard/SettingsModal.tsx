/**
 * SettingsModal - app-level settings accessible from the dashboard.
 *
 * Contains:
 * - Projects folder (where projects are listed/created), with an optional move
 * - Home screen visibility, terminal GPU, and project thumbnail toggles
 * - Analytics opt-out toggle
 *
 * @module components/SettingsModal
 */

import { useState, useEffect, useCallback } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { getAnalyticsEnabled, setAnalyticsEnabled, trackEvent } from '../../lib/analytics';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  DASHBOARD_VISIBILITY_CHANGED_EVENT,
  type DashboardVisibilityChangedDetail,
  getCalendarHidden,
  setCalendarHidden,
  getSlackCtaHidden,
  setSlackCtaHidden,
  getDashboardHeaderHidden,
  setDashboardHeaderHidden,
  getTerminalGpuEnabled,
  setTerminalGpuEnabled,
  getThumbnailsEnabled,
  setThumbnailsEnabled,
  getProjectsRoot,
  isCustomProjectsRoot,
  pickProjectsRoot,
  setProjectsRoot,
  listMovableProjects,
  moveProjectsToRoot,
  type MovableProjects,
} from '../../lib/settings';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { MoveToFolderIcon } from '@/components/icons';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { useOpenModal } from '../../contexts/ModalContext';

const errMsg = (err: unknown) => formatCommandError(asCommandError(err));

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDashboardHeaderHiddenChange?: (hidden: boolean) => void;
  onCalendarHiddenChange?: (hidden: boolean) => void;
  onSlackCtaHiddenChange?: (hidden: boolean) => void;
  /** Called after the projects folder changes (and after a move) so the
   *  dashboard can re-list projects. */
  onProjectsRootChanged?: () => void;
}

/** Pending "move existing projects?" prompt state. */
interface MovePrompt {
  from: string;
  to: string;
  info: MovableProjects;
}

export function SettingsModal({
  isOpen,
  onClose,
  onDashboardHeaderHiddenChange,
  onCalendarHiddenChange,
  onSlackCtaHiddenChange,
  onProjectsRootChanged,
}: SettingsModalProps) {
  const { showToast } = useOptionalToast();
  const openModal = useOpenModal();
  // Projects folder is per-workspace; reflect the active one in the label.
  const { activeAccount, accounts } = useActiveAccount();
  const multipleWorkspaces = accounts.length > 1;

  const [analyticsEnabled, setLocalAnalyticsEnabled] = useState(true);
  const [dashboardHeaderVisible, setLocalDashboardHeaderVisible] = useState(true);
  const [calendarVisible, setLocalCalendarVisible] = useState(true);
  const [slackCtaVisible, setLocalSlackCtaVisible] = useState(true);
  const [terminalGpuEnabled, setLocalTerminalGpuEnabled] = useState(true);
  const [thumbnailsOn, setLocalThumbnailsOn] = useState(true);
  const [loading, setLoading] = useState(true);

  const [projectsRoot, setLocalProjectsRoot] = useState('');
  const [customRoot, setCustomRoot] = useState(false);
  const [savingRoot, setSavingRoot] = useState(false);
  const [movePrompt, setMovePrompt] = useState<MovePrompt | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      const [enabled, headerHidden, calHidden, slackHidden, gpuEnabled, thumbnails, root, custom] =
        await Promise.all([
          getAnalyticsEnabled(),
          getDashboardHeaderHidden(),
          getCalendarHidden(),
          getSlackCtaHidden(),
          getTerminalGpuEnabled(),
          getThumbnailsEnabled(),
          getProjectsRoot().catch(() => ''),
          isCustomProjectsRoot(),
        ]);
      if (!cancelled) {
        setLocalAnalyticsEnabled(enabled);
        setLocalDashboardHeaderVisible(!headerHidden);
        setLocalCalendarVisible(!calHidden);
        setLocalSlackCtaVisible(!slackHidden);
        setLocalTerminalGpuEnabled(gpuEnabled);
        // `null` = not asked yet; the toggle reflects the default-on behavior
        // (the first auto-capture will show the in-app explainer).
        setLocalThumbnailsOn(thumbnails !== false);
        setLocalProjectsRoot(root);
        setCustomRoot(custom);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Keep either Settings modal instance in sync with inline home-screen hide
  // actions or changes made through the other Settings entry point.
  useEffect(() => {
    const handleVisibilityChanged = (event: Event) => {
      const detail = (event as CustomEvent<DashboardVisibilityChangedDetail>).detail;
      if (!detail) return;
      if (detail.key === 'dashboardHeader') setLocalDashboardHeaderVisible(!detail.hidden);
      if (detail.key === 'calendar') setLocalCalendarVisible(!detail.hidden);
      if (detail.key === 'slackCta') setLocalSlackCtaVisible(!detail.hidden);
    };

    window.addEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    return () =>
      window.removeEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
  }, []);

  const handleToggle = useCallback(() => {
    const newValue = !analyticsEnabled;
    setLocalAnalyticsEnabled(newValue);
    void setAnalyticsEnabled(newValue);
    if (newValue) {
      // Track re-enable (this fires before the backend disables, so it gets sent)
      void trackEvent('analytics_enabled', { $screen_name: 'Settings' });
    }
  }, [analyticsEnabled]);

  const handleDashboardHeaderToggle = useCallback(() => {
    const newVisible = !dashboardHeaderVisible;
    setLocalDashboardHeaderVisible(newVisible);
    void setDashboardHeaderHidden(!newVisible);
    onDashboardHeaderHiddenChange?.(!newVisible);
  }, [dashboardHeaderVisible, onDashboardHeaderHiddenChange]);

  const handleCalendarToggle = useCallback(() => {
    const newVisible = !calendarVisible;
    setLocalCalendarVisible(newVisible);
    void setCalendarHidden(!newVisible);
    void trackEvent('calendar_visibility_toggled', {
      visible: newVisible,
      $screen_name: 'Settings',
    });
    onCalendarHiddenChange?.(!newVisible);
  }, [calendarVisible, onCalendarHiddenChange]);

  const handleSlackCtaToggle = useCallback(() => {
    const newVisible = !slackCtaVisible;
    setLocalSlackCtaVisible(newVisible);
    void setSlackCtaHidden(!newVisible);
    onSlackCtaHiddenChange?.(!newVisible);
  }, [slackCtaVisible, onSlackCtaHiddenChange]);

  const handleTerminalGpuToggle = useCallback(() => {
    const newEnabled = !terminalGpuEnabled;
    setLocalTerminalGpuEnabled(newEnabled);
    void setTerminalGpuEnabled(newEnabled);
    void trackEvent('terminal_gpu_toggled', {
      enabled: newEnabled,
      $screen_name: 'Settings',
    });
  }, [terminalGpuEnabled]);

  const handleThumbnailsToggle = useCallback(() => {
    const newEnabled = !thumbnailsOn;
    setLocalThumbnailsOn(newEnabled);
    void setThumbnailsEnabled(newEnabled);
    void trackEvent('thumbnails_toggled', {
      enabled: newEnabled,
      $screen_name: 'Settings',
    });
  }, [thumbnailsOn]);

  // Persist a new projects root, then offer to move existing projects over.
  const applyNewRoot = useCallback(
    async (newRoot: string) => {
      const previous = projectsRoot;
      if (!newRoot || newRoot === previous) return;
      setSavingRoot(true);
      try {
        await setProjectsRoot(newRoot);
        setLocalProjectsRoot(newRoot);
        setCustomRoot(true);
        onProjectsRootChanged?.();
        void trackEvent('projects_root_changed', { is_custom: true, $screen_name: 'Settings' });
        showToast('Projects folder updated', 'success');

        // Offer to move any projects left behind in the previous folder.
        if (previous && previous !== newRoot) {
          const info = await listMovableProjects(previous, newRoot).catch(() => null);
          if (info && (info.movable.length || info.collisions.length || info.open.length)) {
            setMovePrompt({ from: previous, to: newRoot, info });
          }
        }
      } catch (err) {
        showToast(errMsg(err), 'error');
      } finally {
        setSavingRoot(false);
      }
    },
    [projectsRoot, onProjectsRootChanged, showToast]
  );

  const handleChangeFolder = useCallback(async () => {
    try {
      const picked = await pickProjectsRoot();
      if (picked) await applyNewRoot(picked);
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }, [applyNewRoot, showToast]);

  const handleResetFolder = useCallback(async () => {
    setSavingRoot(true);
    try {
      await setProjectsRoot('');
      const root = await getProjectsRoot();
      setLocalProjectsRoot(root);
      setCustomRoot(false);
      onProjectsRootChanged?.();
      void trackEvent('projects_root_changed', { is_custom: false, $screen_name: 'Settings' });
      showToast('Reset to the default projects folder', 'success');
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      setSavingRoot(false);
    }
  }, [onProjectsRootChanged, showToast]);

  const handleConfirmMove = useCallback(async () => {
    if (!movePrompt) return;
    setMoving(true);
    try {
      const report = await moveProjectsToRoot(movePrompt.from, movePrompt.to);
      onProjectsRootChanged?.();
      void trackEvent('projects_moved', {
        moved_count: report.moved.length,
        skipped_count: report.skipped.length,
        $screen_name: 'Settings',
      });
      const movedMsg = `Moved ${report.moved.length} project${report.moved.length === 1 ? '' : 's'}`;
      const skipMsg = report.skipped.length ? `, skipped ${report.skipped.length}` : '';
      showToast(`${movedMsg}${skipMsg}`, report.skipped.length ? 'info' : 'success');
      setMovePrompt(null);
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      setMoving(false);
    }
  }, [movePrompt, onProjectsRootChanged, showToast]);

  return (
    <>
      <ModalFrame isOpen={isOpen} onClose={onClose} title="Settings" className="settings-modal">
        <div className="settings-modal-body">
          <div className="settings-section">
            <div className="settings-row settings-row--stacked">
              <div className="settings-row-info">
                <span className="settings-row-label">
                  Projects folder
                  {multipleWorkspaces && activeAccount && (
                    <span className="settings-folder-workspace">
                      <span
                        className="settings-folder-workspace-dot"
                        style={{ backgroundColor: activeAccount.color }}
                      />
                      {activeAccount.name}
                    </span>
                  )}
                </span>
                <span className="settings-row-description">
                  {multipleWorkspaces && activeAccount
                    ? `Where the ${activeAccount.name} workspace lists and creates projects. Each workspace can use its own folder.`
                    : 'Where Ship Studio lists and creates your projects. Point this at an existing dev directory to keep everything in one place.'}
                </span>
                <button
                  type="button"
                  className="settings-folder-field"
                  onClick={() => void handleChangeFolder()}
                  disabled={savingRoot || loading}
                  title="Change projects folder"
                  aria-label="Change projects folder"
                >
                  <span className="settings-folder-field-path">
                    {projectsRoot || '—'}
                    {!customRoot && projectsRoot ? ' (default)' : ''}
                  </span>
                  <MoveToFolderIcon size={14} />
                </button>
                {customRoot && (
                  <button
                    type="button"
                    className="settings-folder-reset"
                    onClick={() => void handleResetFolder()}
                    disabled={savingRoot}
                  >
                    Reset to default
                  </button>
                )}
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Shared libraries</span>
                <span className="settings-row-description">
                  Folders your agent brings along to every project in this workspace — brand docs,
                  snippets, your own skills. Works with Claude Code.
                </span>
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  onClose();
                  openModal('attachedLibraries');
                }}
              >
                Manage
              </Button>
            </div>
            <div className="settings-group">
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Show home screen header</span>
                  <span className="settings-row-description">
                    Show the Ship Studio logo and greeting at the top of the dashboard.
                  </span>
                </div>
                <button
                  className={`settings-toggle ${dashboardHeaderVisible ? 'on' : 'off'}`}
                  onClick={handleDashboardHeaderToggle}
                  disabled={loading}
                  role="switch"
                  aria-label="Show home screen header"
                  aria-checked={dashboardHeaderVisible}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Show activity calendar</span>
                  <span className="settings-row-description">
                    Show your GitHub contribution graph on the dashboard.
                  </span>
                </div>
                <button
                  className={`settings-toggle ${calendarVisible ? 'on' : 'off'}`}
                  onClick={handleCalendarToggle}
                  disabled={loading}
                  role="switch"
                  aria-label="Show activity calendar"
                  aria-checked={calendarVisible}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Show community banner</span>
                  <span className="settings-row-description">
                    Show the Slack community invite on the dashboard.
                  </span>
                </div>
                <button
                  className={`settings-toggle ${slackCtaVisible ? 'on' : 'off'}`}
                  onClick={handleSlackCtaToggle}
                  disabled={loading}
                  role="switch"
                  aria-label="Show community banner"
                  aria-checked={slackCtaVisible}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Terminal GPU acceleration</span>
                <span className="settings-row-description">
                  Use GPU rendering for faster, smoother terminals. Turn off if agent output looks
                  garbled or fragmented (a known issue on some macOS beta builds). Applies to newly
                  opened terminals.
                </span>
              </div>
              <button
                className={`settings-toggle ${terminalGpuEnabled ? 'on' : 'off'}`}
                onClick={handleTerminalGpuToggle}
                disabled={loading}
                role="switch"
                aria-checked={terminalGpuEnabled}
              >
                <span className="settings-toggle-track">
                  <span className="settings-toggle-thumb" />
                </span>
              </button>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Project thumbnails</span>
                <span className="settings-row-description">
                  Automatically screenshot the preview to show project thumbnails on the dashboard.
                  On macOS this may require Screen Recording permission — allow Ship Studio under
                  System Settings → Privacy &amp; Security → Screen Recording, then turn this back
                  on.
                </span>
              </div>
              <button
                className={`settings-toggle ${thumbnailsOn ? 'on' : 'off'}`}
                onClick={handleThumbnailsToggle}
                disabled={loading}
                role="switch"
                aria-checked={thumbnailsOn}
              >
                <span className="settings-toggle-track">
                  <span className="settings-toggle-thumb" />
                </span>
              </button>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Usage analytics</span>
                <span className="settings-row-description">
                  Help improve Ship Studio by sharing usage data like feature usage, and errors.
                </span>
              </div>
              <button
                className={`settings-toggle ${analyticsEnabled ? 'on' : 'off'}`}
                onClick={handleToggle}
                disabled={loading}
                role="switch"
                aria-checked={analyticsEnabled}
              >
                <span className="settings-toggle-track">
                  <span className="settings-toggle-thumb" />
                </span>
              </button>
            </div>
          </div>
        </div>
      </ModalFrame>

      {movePrompt && (
        <ModalFrame
          isOpen={true}
          onClose={() => !moving && setMovePrompt(null)}
          title="Move existing projects?"
          className="settings-modal"
        >
          <div className="settings-modal-body">
            <p className="settings-move-intro">
              {movePrompt.info.movable.length > 0 ? (
                <>
                  Move{' '}
                  <strong>
                    {movePrompt.info.movable.length} project
                    {movePrompt.info.movable.length === 1 ? '' : 's'}
                  </strong>{' '}
                  from your previous folder into the new one?
                </>
              ) : (
                <>There are no projects that can be moved cleanly into the new folder.</>
              )}
            </p>
            <p className="settings-move-paths">
              <span title={movePrompt.from}>{movePrompt.from}</span>
              <span aria-hidden> → </span>
              <span title={movePrompt.to}>{movePrompt.to}</span>
            </p>
            {movePrompt.info.collisions.length > 0 && (
              <p className="settings-move-note">
                {movePrompt.info.collisions.length} skipped — a folder with the same name already
                exists in the destination.
              </p>
            )}
            {movePrompt.info.open.length > 0 && (
              <p className="settings-move-note">
                {movePrompt.info.open.length} skipped — currently open. Close them first to move.
              </p>
            )}
            <div className="settings-move-actions">
              <Button variant="ghost" onClick={() => setMovePrompt(null)} disabled={moving}>
                Not now
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleConfirmMove()}
                disabled={moving || movePrompt.info.movable.length === 0}
              >
                {moving
                  ? 'Moving…'
                  : `Move ${movePrompt.info.movable.length} project${movePrompt.info.movable.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </div>
        </ModalFrame>
      )}
    </>
  );
}
