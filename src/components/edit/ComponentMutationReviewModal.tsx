import type { ComponentMutationPreview } from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';

export interface ComponentMutationReviewModalProps {
  preview: ComponentMutationPreview;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

function diffLineClass(line: string) {
  if (line.startsWith('@@')) return 'ss-components-review__line ss-components-review__line--hunk';
  if (line.startsWith('+')) return 'ss-components-review__line ss-components-review__line--add';
  if (line.startsWith('-')) return 'ss-components-review__line ss-components-review__line--delete';
  return 'ss-components-review__line';
}

/** Review gate for parser-planned component source edits. */
export function ComponentMutationReviewModal({
  preview,
  busy = false,
  onCancel,
  onConfirm,
}: ComponentMutationReviewModalProps) {
  const fileCount = preview.files.length;

  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      dismissable={!busy}
      className="ss-components-review-modal"
      title="Review component source changes"
    >
      <div className="ss-components-review">
        <p className="ss-components-review__intro">
          Nothing has been written yet. Review the exact source diff before applying this component
          placement.
        </p>

        <div className="ss-components-review__files" aria-busy={busy}>
          {preview.files.map((file) => (
            <section key={file.file} className="ss-components-review__file">
              <header className="ss-components-review__file-header">
                <code>{file.file}</code>
                <span className="ss-components-review__stats">
                  <span className="ss-components-review__stat--add">+{file.additions}</span>
                  <span className="ss-components-review__stat--delete">-{file.deletions}</span>
                </span>
              </header>
              <div
                className="ss-components-review__diff"
                role="region"
                aria-label={`Source diff for ${file.file}`}
              >
                {file.diff.split('\n').map((line, index) => (
                  <code key={`${file.file}-${index}`} className={diffLineClass(line)}>
                    {line || ' '}
                  </code>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="ss-components-review__footer">
          <span className="ss-components-muted">
            {fileCount} {fileCount === 1 ? 'file' : 'files'} · guarded by the current source hash
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
              {busy ? 'Applying…' : 'Apply changes'}
            </Button>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}
