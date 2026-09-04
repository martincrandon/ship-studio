import { useEffect, useState } from 'react';
import { ComponentsIcon } from '@/components/icons';
import type {
  ComponentExtractionPreview,
  ComponentExtractionProposal,
} from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextField } from '../primitives/TextField';

export interface ComponentExtractionApproval {
  componentName: string;
  destinationFile: string;
  approvedPropNames: string[];
}

export interface ComponentExtractionReviewModalProps {
  proposal?: ComponentExtractionProposal | null;
  preview?: ComponentExtractionPreview | null;
  busy?: boolean;
  onCancel: () => void;
  onApprove?: (approval: ComponentExtractionApproval) => void | Promise<void>;
  onConfirm?: () => void | Promise<void>;
}

function sourceLines(file: ComponentExtractionPreview['files'][number]) {
  const before = file.before === undefined ? [] : file.before.split('\n');
  const after = file.after === undefined ? [] : file.after.split('\n');
  if (file.operation === 'create') return after.map((line) => `+${line}`);
  if (file.operation === 'delete') return before.map((line) => `-${line}`);
  return [
    `--- ${file.file}`,
    ...before.map((line) => `-${line}`),
    `+++ ${file.file}`,
    ...after.map((line) => `+${line}`),
  ];
}

function lineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'ss-components-review__line ss-components-review__line--hunk';
  }
  if (line.startsWith('+')) return 'ss-components-review__line ss-components-review__line--add';
  if (line.startsWith('-')) {
    return 'ss-components-review__line ss-components-review__line--delete';
  }
  return 'ss-components-review__line';
}

/** Two-step extraction gate: approve boundary props, then review exact files. */
export function ComponentExtractionReviewModal({
  proposal,
  preview,
  busy = false,
  onCancel,
  onApprove,
  onConfirm,
}: ComponentExtractionReviewModalProps) {
  const [componentName, setComponentName] = useState('');
  const [destinationFile, setDestinationFile] = useState('');
  const [approvedProps, setApprovedProps] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!proposal) return;
    // The approval form mirrors a newly received proposal into its local draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setComponentName(proposal.componentName);
    setDestinationFile(proposal.destinationFile);
    setApprovedProps(new Set(proposal.proposedPropNames));
  }, [proposal]);

  if (proposal && onApprove) {
    const canContinue = componentName.trim() !== '' && destinationFile.trim() !== '';
    return (
      <ModalFrame
        isOpen
        onClose={onCancel}
        dismissable={!busy}
        className="ss-components-extraction-modal"
        title="Create component from selection"
      >
        <div className="ss-components-review ss-components-extraction">
          <p className="ss-components-review__intro">
            Ship Studio found one exact JSX subtree. Confirm the new definition name, destination,
            and every value that must cross the component boundary. Nothing has been written.
          </p>
          <label className="ss-components-refactor-form__field">
            <span>Component name</span>
            <TextField
              autoFocus
              value={componentName}
              onChange={(event) => setComponentName(event.currentTarget.value)}
              aria-label="Extracted component name"
            />
          </label>
          <label className="ss-components-refactor-form__field">
            <span>Destination file</span>
            <TextField
              value={destinationFile}
              onChange={(event) => setDestinationFile(event.currentTarget.value)}
              aria-label="Extracted component destination file"
            />
          </label>
          <section
            className="ss-components-extraction__props"
            aria-labelledby="extraction-props-title"
          >
            <div className="ss-components-extraction__heading">
              <div>
                <h3 id="extraction-props-title" className="ss-components-section-title">
                  Boundary values
                </h3>
                <p className="ss-components-muted">
                  Approved values become explicit props on the new component.
                </p>
              </div>
              <span className="ss-components-count tabular-nums">{approvedProps.size}</span>
            </div>
            {proposal.proposedPropNames.length === 0 ? (
              <p className="ss-components-muted">No free values cross this boundary.</p>
            ) : (
              <div className="ss-components-extraction__prop-list">
                {proposal.proposedPropNames.map((name) => (
                  <label key={name} className="ss-components-extraction__prop">
                    <input
                      type="checkbox"
                      checked={approvedProps.has(name)}
                      onChange={(event) =>
                        setApprovedProps((current) => {
                          const next = new Set(current);
                          if (event.currentTarget.checked) next.add(name);
                          else next.delete(name);
                          return next;
                        })
                      }
                    />
                    <code>{name}</code>
                  </label>
                ))}
              </div>
            )}
          </section>
          <p className="ss-components-extraction__hint">
            <ComponentsIcon size={14} aria-hidden="true" />
            Control-flow, dynamic scope, stale source, and server/client boundary changes remain
            read-only.
          </p>
          <div className="ss-components-review__actions">
            <Button variant="ghost" size="compact" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="compact"
              disabled={!canContinue || busy}
              onClick={() =>
                void onApprove({
                  componentName: componentName.trim(),
                  destinationFile: destinationFile.trim(),
                  approvedPropNames: [...approvedProps].sort(),
                })
              }
              leftIcon={<ComponentsIcon size={14} />}
            >
              {busy ? 'Planning…' : 'Review source changes'}
            </Button>
          </div>
        </div>
      </ModalFrame>
    );
  }

  if (!preview || !onConfirm) return null;
  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      dismissable={!busy}
      className="ss-components-review-modal"
      title="Review extracted component"
    >
      <div className="ss-components-review">
        <p className="ss-components-review__intro">
          Review the new definition and the exact replacement import before applying this
          extraction. The current source hash guards both files.
        </p>
        <div className="ss-components-review__files" aria-busy={busy}>
          {preview.files.map((file) => (
            <section key={file.file} className="ss-components-review__file">
              <header className="ss-components-review__file-header">
                <code>{file.file}</code>
                <span className="ss-components-review__stats">
                  {file.operation === 'create' ? 'new file' : file.operation}
                </span>
              </header>
              <div
                className="ss-components-review__diff"
                role="region"
                aria-label={`Extracted source for ${file.file}`}
              >
                {sourceLines(file).map((line, index) => (
                  <code key={`${file.file}-${index}`} className={lineClass(line)}>
                    {line || ' '}
                  </code>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="ss-components-review__footer">
          <span className="ss-components-muted">
            {preview.affectedFiles.length} files · {preview.proposedPropNames.length} approved props
          </span>
          <div className="ss-components-review__actions">
            <Button variant="ghost" size="compact" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="compact"
              disabled={busy}
              onClick={() => void onConfirm()}
            >
              {busy ? 'Extracting…' : 'Apply extraction'}
            </Button>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}
