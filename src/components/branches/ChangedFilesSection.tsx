import { useId, useState, type ReactNode } from 'react';
import { ChevronIcon, FileIcon, TrashIcon } from '@/components/icons';
import type { ChangedFile, ChangeStatus, ChangedFileSummary } from '../../lib/git';
import { DiffModal } from './DiffModal';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';

interface ChangedFilesSectionProps {
  /** Null means the file query failed or has not returned yet. */
  changedFiles: ChangedFile[] | null;
  summary?: ChangedFileSummary | null;
  headerAction?: ReactNode;
  loading?: boolean;
  projectPath: string;
}

interface DiscardAllButtonProps {
  confirming: boolean;
  isDiscarding: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** The two visible discard affordances share confirmation state in the dropdown. */
export function DiscardAllButton({
  confirming,
  isDiscarding,
  disabled = false,
  onClick,
}: DiscardAllButtonProps) {
  return (
    <Button
      variant="danger"
      size="compact"
      className={`publish-discard-button ${confirming ? 'confirming' : ''}`}
      leftIcon={<TrashIcon size={12} />}
      onClick={onClick}
      disabled={isDiscarding || disabled}
      aria-label={confirming ? 'Confirm discard all changes' : 'Discard all changes'}
    >
      {isDiscarding ? 'Discarding…' : confirming ? 'Click to Confirm' : 'Discard All'}
    </Button>
  );
}

/** Inline Local-section action; shares the dropdown's confirmation state. */
export function DiscardAllTextButton({
  confirming,
  isDiscarding,
  disabled = false,
  onClick,
}: DiscardAllButtonProps) {
  return (
    <TextButton
      variant="danger"
      className={`publish-discard-text-button ${confirming ? 'confirming' : ''}`}
      onClick={onClick}
      disabled={isDiscarding || disabled}
      aria-label={confirming ? 'Confirm discard all changes' : 'Discard all changes'}
    >
      {isDiscarding ? 'Discarding…' : confirming ? 'Click to Confirm' : 'Discard All'}
    </TextButton>
  );
}

/** Presents changed files for a project with selection and discard controls. */
export function ChangedFilesSection({
  changedFiles,
  summary = null,
  headerAction,
  loading = false,
  projectPath,
}: ChangedFilesSectionProps) {
  const [selectedFile, setSelectedFile] = useState<{ path: string; status: ChangeStatus } | null>(
    null
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const listId = useId();

  const getStatusIndicator = (status: ChangeStatus) => {
    switch (status) {
      case 'added':
      case 'untracked':
        return <span className="change-status change-added">+</span>;
      case 'deleted':
        return <span className="change-status change-deleted">-</span>;
      case 'renamed':
        return <span className="change-status change-renamed">R</span>;
      default:
        return <span className="change-status change-modified">M</span>;
    }
  };

  const getFileName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] ?? path;
  };

  const getDirectory = (path: string) => {
    const parts = path.split('/');
    return parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
  };

  const changeCount = changedFiles?.length ?? null;
  const totalsKnown =
    summary?.additions !== null &&
    summary?.additions !== undefined &&
    summary?.deletions !== null &&
    summary?.deletions !== undefined;

  return (
    <>
      <section className="publish-changes-section" aria-labelledby="publish-changes-heading">
        <div className="branch-changes-header">
          {changeCount !== null ? (
            <button
              type="button"
              className="publish-changes-disclosure"
              id="publish-changes-heading"
              aria-expanded={isExpanded}
              aria-controls={listId}
              aria-label={`${changeCount} uncommitted ${changeCount === 1 ? 'change' : 'changes'}. ${totalsKnown ? `${summary?.additions} lines added, ${summary?.deletions} lines removed` : 'Line totals unavailable'}. ${isExpanded ? 'Hide' : 'Show'} changed files.`}
              onClick={() => setIsExpanded((expanded) => !expanded)}
            >
              <ChevronIcon size={12} className="publish-changes-disclosure-icon" />
              <span className="publish-change-count">
                {`${changeCount} uncommitted ${changeCount === 1 ? 'change' : 'changes'}`}
              </span>
              <span
                className="publish-change-totals"
                aria-label={
                  totalsKnown
                    ? `${summary?.additions} lines added, ${summary?.deletions} lines removed`
                    : 'Line change totals unavailable'
                }
              >
                {totalsKnown ? (
                  <>
                    <span className="diff-stat-add">+{summary?.additions}</span>
                    <span className="diff-stat-delete">−{summary?.deletions}</span>
                  </>
                ) : (
                  <span className="publish-change-totals-unknown">—</span>
                )}
              </span>
            </button>
          ) : (
            <div className="branch-changes-heading-copy" id="publish-changes-heading">
              <span>{changeCount === null ? 'Uncommitted changes' : '0 uncommitted changes'}</span>
            </div>
          )}
          {headerAction}
        </div>
        {changeCount !== null ? (
          <div className="branch-changes-list" id={listId} hidden={!isExpanded}>
            {changeCount === 0 ? (
              <div className="branch-changes-empty publish-zero-changes-empty">
                No uncommitted changes.
              </div>
            ) : (
              changedFiles?.map((file) => (
                <button
                  type="button"
                  key={`${file.status}:${file.path}`}
                  className="branch-changes-item branch-changes-item-clickable"
                  onClick={() => setSelectedFile({ path: file.path, status: file.status })}
                >
                  {getStatusIndicator(file.status)}
                  <FileIcon size={12} />
                  <span className="branch-changes-path">
                    <span className="branch-changes-dir">{getDirectory(file.path)}</span>
                    <span className="branch-changes-filename">{getFileName(file.path)}</span>
                  </span>
                  <span
                    className="publish-file-stats"
                    aria-label={
                      file.additions != null && file.deletions != null
                        ? `${file.additions} lines added, ${file.deletions} lines removed`
                        : 'Line change totals unavailable'
                    }
                  >
                    {file.additions != null && file.deletions != null ? (
                      <>
                        <span className="diff-stat-add">+{file.additions}</span>
                        <span className="diff-stat-delete">−{file.deletions}</span>
                      </>
                    ) : (
                      <span className="publish-change-totals-unknown">—</span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="branch-changes-empty" role="status">
            {loading ? 'Checking for uncommitted changes…' : 'Couldn’t check the changed files.'}
          </div>
        )}
      </section>

      {selectedFile && (
        <DiffModal
          projectPath={projectPath}
          filePath={selectedFile.path}
          fileStatus={selectedFile.status}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </>
  );
}
