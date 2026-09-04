import type { ComponentRefactorPreview } from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';

export interface ComponentRefactorReviewModalProps {
  preview: ComponentRefactorPreview;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

function lineClass(line: string) {
  if (line.startsWith('+')) return 'ss-components-review__line ss-components-review__line--add';
  if (line.startsWith('-')) {
    return 'ss-components-review__line ss-components-review__line--delete';
  }
  return 'ss-components-review__line';
}

function operationCopy(operation: ComponentRefactorPreview['operation']) {
  if (operation === 'duplicate') {
    return {
      title: 'Review component duplicate',
      intro:
        'Nothing has been written yet. Review the complete new source file before creating this component definition.',
      confirm: 'Create component',
      busy: 'Creating…',
    };
  }
  if (operation === 'rename') {
    return {
      title: 'Review component rename',
      intro:
        'Nothing has been written yet. Review every definition, import, namespace, and JSX reference before renaming this component.',
      confirm: 'Rename component',
      busy: 'Renaming…',
    };
  }
  return {
    title: 'Review component deletion',
    intro:
      'Nothing has been deleted yet. Review every source file that will be affected before removing this component definition.',
    confirm: 'Delete component',
    busy: 'Deleting…',
  };
}

/** Review gate for definition lifecycle source operations. */
export function ComponentRefactorReviewModal({
  preview,
  busy = false,
  onCancel,
  onConfirm,
}: ComponentRefactorReviewModalProps) {
  const copy = operationCopy(preview.operation);
  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      dismissable={!busy}
      className="ss-components-review-modal"
      title={copy.title}
    >
      <div className="ss-components-review">
        <p className="ss-components-review__intro">{copy.intro}</p>
        <div className="ss-components-review__files" aria-busy={busy}>
          {preview.files.map((file) => {
            const beforeLines = file.before === undefined ? [] : file.before.split('\n');
            const afterLines = file.after === undefined ? [] : file.after.split('\n');
            const lines =
              file.operation === 'create'
                ? afterLines.map((line) => `+${line}`)
                : file.operation === 'delete'
                  ? beforeLines.map((line) => `-${line}`)
                  : [
                      ...beforeLines.map((line) => `-${line}`),
                      ...afterLines.map((line) => `+${line}`),
                    ];
            return (
              <section key={file.file} className="ss-components-review__file">
                <header className="ss-components-review__file-header">
                  <code>{file.file}</code>
                  <span className="ss-components-review__stats">
                    {file.operation !== 'delete' && (
                      <span className="ss-components-review__stat--add">+{afterLines.length}</span>
                    )}
                    {file.operation !== 'create' && (
                      <span className="ss-components-review__stat--delete">
                        -{beforeLines.length}
                      </span>
                    )}
                    <span>{file.operation === 'create' ? 'new file' : file.operation}</span>
                  </span>
                </header>
                <div
                  className="ss-components-review__diff"
                  role="region"
                  aria-label={`${file.operation === 'create' ? 'New' : 'Changed'} source for ${file.file}`}
                >
                  {lines.map((line, index) => (
                    <code key={`${file.file}-${index}`} className={lineClass(line)}>
                      {line || (file.operation === 'delete' ? '-' : '+')}
                    </code>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        <div className="ss-components-review__footer">
          <span className="ss-components-muted">
            {preview.affectedFiles.length} {preview.affectedFiles.length === 1 ? 'file' : 'files'} ·
            guarded by the current source graph
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
              {busy ? copy.busy : copy.confirm}
            </Button>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}
