/**
 * The "Settings" tab of the cascade editor (Stacki's Style/Settings split) — edits
 * the selected element's MARKUP: TEXT and TAG edits use guarded source resolvers;
 * CLASSES and ATTRIBUTES keep their existing inline editing controls.
 */

import { useRef, useState, type KeyboardEvent } from 'react';
import { ChevronIcon, CloseIcon, PlusIcon } from '@/components/icons';
import { useCommands } from '../../commands/useCommands';
import type { ElementSettings } from '../../hooks/useElementSettings';
import { CascadeChip } from './CascadeChip';
import { getElementIcon } from './element-icons';
import { ContextMenuLabel } from '../primitives/ContextMenu';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';

const TEXT_DISPLAY_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'button',
  'caption',
  'cite',
  'code',
  'data',
  'dd',
  'del',
  'dfn',
  'dt',
  'em',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'mark',
  'option',
  'output',
  'p',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'td',
  'textarea',
  'th',
  'time',
  'u',
  'var',
]);

function displaysText(tag: string): boolean {
  const normalizedTag = tag.toLowerCase();
  return TEXT_DISPLAY_TAGS.has(normalizedTag) || normalizedTag.includes('-');
}

export function ElementSettingsPanel({ settings }: { settings: ElementSettings }) {
  const {
    tag,
    selectionKey,
    classes,
    attributes,
    addClass,
    renameClass,
    removeClass,
    setAttribute,
    renameAttribute,
    removeAttribute,
    canEditAttributes,
    tagOptions,
    canEditTag,
    setTag,
    text: sourceText,
    textReason,
    canEditText,
    setText,
  } = settings;
  const showTextField = displaysText(tag);
  type TextEditState = {
    selectionKey: string;
    sourceText: string;
    draft: string;
    original: string;
    editing: boolean;
  };
  const [adding, setAdding] = useState(false);
  const [classText, setClassText] = useState('');
  const [textEditState, setTextEditState] = useState<TextEditState>(() => ({
    selectionKey,
    sourceText,
    draft: sourceText,
    original: sourceText,
    editing: false,
  }));
  const currentTextEdit =
    textEditState.selectionKey === selectionKey && textEditState.sourceText === sourceText
      ? textEditState
      : { selectionKey, sourceText, draft: sourceText, original: sourceText, editing: false };
  const { draft: textDraft, editing: editingText } = currentTextEdit;
  const panelRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const draftSelectionKeyRef = useRef(selectionKey);
  const textCommitRef = useRef(false);
  const textCancelledRef = useRef(false);

  const submit = () => {
    const v = classText.trim();
    if (v) addClass(v);
    setClassText('');
    setAdding(false);
  };

  const commitText = () => {
    if (textCancelledRef.current) {
      textCancelledRef.current = false;
      return;
    }
    if (!editingText || textCommitRef.current) return;
    if (draftSelectionKeyRef.current !== selectionKey) {
      setTextEditState({
        selectionKey,
        sourceText,
        draft: sourceText,
        original: sourceText,
        editing: false,
      });
      textCommitRef.current = false;
      return;
    }
    const next = textDraft;
    const original = currentTextEdit.original;
    setTextEditState({ ...currentTextEdit, editing: false });
    if (next === original) return;
    textCommitRef.current = true;
    void setText(next)
      .then((saved) => {
        if (!saved) {
          setTextEditState((state) =>
            state.selectionKey === selectionKey
              ? {
                  selectionKey,
                  sourceText,
                  draft: sourceText,
                  original: sourceText,
                  editing: false,
                }
              : state
          );
        }
      })
      .finally(() => {
        textCommitRef.current = false;
      });
  };

  const cancelText = () => {
    textCancelledRef.current = true;
    setTextEditState({
      selectionKey,
      sourceText,
      draft: sourceText,
      original: sourceText,
      editing: false,
    });
    textCommitRef.current = false;
  };

  useCommands(
    () => [
      {
        id: 'elementSettings.focusText',
        title: 'Edit selected element text',
        category: 'action',
        when: ({ kind }) => kind === 'project' && showTextField && canEditText && !settings.busy,
        keywords: ['content', 'copy', 'headline', 'label'],
        run: () => textInputRef.current?.focus(),
      },
      {
        id: 'elementSettings.openTagMenu',
        title: 'Change selected element tag',
        category: 'action',
        when: ({ kind }) => kind === 'project' && canEditTag && !settings.busy,
        keywords: ['element', 'heading', 'paragraph', 'link', 'tag'],
        run: () =>
          panelRef.current
            ?.querySelector<HTMLButtonElement>('[aria-label="Change element tag"]')
            ?.click(),
      },
    ],
    [canEditTag, canEditText, settings.busy, showTextField]
  );

  return (
    <div className="ss-settings" ref={panelRef}>
      <section className="ss-settings__group">
        <h4 className="ss-settings__label">Tag</h4>
        <Dropdown
          menuClassName="ss-settings__tag-menu"
          trigger={(props) => (
            <MenuButton
              ref={props.ref}
              onClick={props.onClick}
              aria-haspopup={props['aria-haspopup']}
              expanded={props['aria-expanded']}
              variant="ghost"
              size="compact"
              className="ss-settings__tag-trigger"
              disabled={!canEditTag || settings.busy}
              aria-label="Change element tag"
              title={canEditTag ? 'Change element tag' : undefined}
            >
              <CascadeChip tone="selector" className="ss-settings__tag-chip">
                <span className="ss-settings__tag-name">{tag || '—'}</span>
                <ChevronIcon size={10} />
              </CascadeChip>
            </MenuButton>
          )}
        >
          <ContextMenuLabel className="ss-settings__tag-menu-heading">
            Swap tag type
          </ContextMenuLabel>
          {tagOptions.map((option) => (
            <DropdownItem
              key={option.tag}
              active={option.tag === tag}
              disabled={settings.busy}
              icon={
                getElementIcon(option.tag) ??
                getElementIcon(/^h[4-6]$/.test(option.tag) ? 'h3' : 'unknown')
              }
              onSelect={() => void setTag(option.tag)}
            >
              {option.label}
            </DropdownItem>
          ))}
        </Dropdown>
      </section>

      <section className="ss-settings__group">
        <h4 className="ss-settings__label">Classes</h4>
        <div className="ss-settings__classes">
          {classes.map((c) => (
            <EditableClassChip
              key={c}
              name={c}
              disabled={settings.busy}
              onRename={(next) => renameClass(c, next)}
              onRemove={() => removeClass(c)}
            />
          ))}
          {adding ? (
            <input
              className="ss-settings__class-input"
              autoFocus
              value={classText}
              spellCheck={false}
              autoComplete="off"
              placeholder="class name"
              onChange={(e) => setClassText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                else if (e.key === 'Escape') {
                  setClassText('');
                  setAdding(false);
                }
              }}
              onBlur={submit}
            />
          ) : (
            <button
              type="button"
              className="ss-settings__class-add"
              onClick={() => setAdding(true)}
            >
              <PlusIcon size={10} /> add
            </button>
          )}
        </div>
      </section>

      {showTextField && (
        <section className="ss-settings__group">
          <h4 className="ss-settings__label">Text</h4>
          <textarea
            key={selectionKey}
            ref={textInputRef}
            className="ss-settings__text-input"
            aria-label="Text content"
            value={textDraft}
            disabled={!canEditText || settings.busy}
            placeholder={
              textReason === 'Resolving selected text…' ? 'Resolving source…' : undefined
            }
            spellCheck
            onFocus={() => {
              textCancelledRef.current = false;
              draftSelectionKeyRef.current = selectionKey;
              setTextEditState({ ...currentTextEdit, original: sourceText, editing: true });
            }}
            onChange={(event) => {
              setTextEditState({
                ...currentTextEdit,
                draft: event.target.value,
                editing: true,
              });
            }}
            onBlur={commitText}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelText();
                event.currentTarget.blur();
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commitText();
              }
            }}
          />
          {textReason && <p className="ss-settings__text-reason">{textReason}</p>}
          {canEditText && (
            <p className="ss-settings__text-help">Cmd/Ctrl+Enter saves · Esc cancels</p>
          )}
        </section>
      )}

      <section className="ss-settings__group ss-settings__group--attributes">
        <h4 className="ss-settings__label">Attributes</h4>
        <ul className="ss-settings__attrs">
          {attributes.map((a) => (
            <AttrRow
              key={a.name}
              name={a.name}
              value={a.value}
              editable={canEditAttributes && !settings.busy}
              onSetValue={(v) => setAttribute(a.name, v)}
              onRename={(n) => renameAttribute(a.name, n, a.value)}
              onRemove={() => removeAttribute(a.name)}
            />
          ))}
        </ul>
        {canEditAttributes && <AddAttr onAdd={(name, value) => setAttribute(name, value)} />}
        {attributes.length === 0 && !canEditAttributes && (
          <p className="ss-settings__empty">No other attributes.</p>
        )}
      </section>
    </div>
  );
}

/** A class chip is its own small inline editor. Click the name, type the new
 *  source class, and commit with Enter or blur; Escape leaves it unchanged. */
function EditableClassChip({
  name,
  disabled,
  onRename,
  onRemove,
}: {
  name: string;
  disabled: boolean;
  onRename: (nextName: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const cancelled = useRef(false);

  const start = () => {
    if (disabled) return;
    cancelled.current = false;
    setText(name);
    setEditing(true);
  };
  const finish = () => {
    setEditing(false);
    if (cancelled.current) return;
    const next = text.trim();
    if (next && next !== name) onRename(next);
  };

  return (
    <CascadeChip
      tone="selector"
      editing={editing}
      interactive={!disabled}
      className="ss-settings__class-chip"
    >
      {editing ? (
        <input
          className="ss-cascade-chip__input"
          autoFocus
          value={text}
          size={Math.max(1, text.length)}
          spellCheck={false}
          autoComplete="off"
          aria-label={`Rename .${name}`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setText(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="ss-cascade-chip__content ss-settings__class-name"
            title={`Rename .${name}`}
            disabled={disabled}
            onClick={start}
          >
            .{name}
          </button>
          <button
            type="button"
            className="ss-settings__class-remove"
            title={`Remove .${name}`}
            aria-label={`Remove .${name}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <CloseIcon size={10} />
          </button>
        </>
      )}
    </CascadeChip>
  );
}

/** One attribute row: click-to-edit KEY and VALUE, plus a remove button. */
function AttrRow({
  name,
  value,
  editable,
  onSetValue,
  onRename,
  onRemove,
}: {
  name: string;
  value: string;
  editable: boolean;
  onSetValue: (value: string) => void;
  onRename: (newName: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState<null | 'name' | 'value'>(null);
  const [text, setText] = useState('');

  const start = (field: 'name' | 'value') => {
    setText(field === 'name' ? name : value);
    setEditing(field);
  };
  const commit = () => {
    if (editing === 'name') {
      const n = text.trim();
      if (n && n !== name) onRename(n);
    } else if (editing === 'value' && text !== value) {
      onSetValue(text);
    }
    setEditing(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') setEditing(null);
  };

  return (
    <li className="ss-settings__attr">
      {editing === 'name' ? (
        <input
          className="ss-settings__attr-input ss-settings__attr-input--name"
          autoFocus
          value={text}
          spellCheck={false}
          autoComplete="off"
          // Attribute names are idents — no spaces.
          onChange={(e) => setText(e.target.value.replace(/\s+/g, ''))}
          onKeyDown={onKey}
          onBlur={commit}
        />
      ) : (
        <button
          type="button"
          className="ss-settings__attr-key"
          disabled={!editable}
          title={editable ? 'Click to rename' : undefined}
          onClick={() => start('name')}
        >
          {name}
        </button>
      )}
      <span className="ss-settings__attr-eq">=</span>
      {editing === 'value' ? (
        <input
          className="ss-settings__attr-input"
          autoFocus
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
        />
      ) : (
        <button
          type="button"
          className="ss-settings__attr-value ss-settings__attr-value--editable"
          disabled={!editable}
          title={editable ? 'Click to edit' : undefined}
          onClick={() => start('value')}
        >
          {value || <span className="ss-settings__attr-empty">empty</span>}
        </button>
      )}
      {editable && (
        <button
          type="button"
          className="ss-settings__attr-remove"
          title={`Remove ${name}`}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <CloseIcon size={10} />
        </button>
      )}
    </li>
  );
}

/** "+ attribute" affordance: expands to name + value inputs. */
function AddAttr({ onAdd }: { onAdd: (name: string, value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const submit = () => {
    const n = name.trim();
    if (n) onAdd(n, value);
    setName('');
    setValue('');
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="ss-settings__attr-add-btn" onClick={() => setOpen(true)}>
        <PlusIcon size={11} /> Add attribute
      </button>
    );
  }
  return (
    <div className="ss-settings__attr-add">
      <input
        className="ss-settings__attr-input"
        autoFocus
        value={name}
        spellCheck={false}
        autoComplete="off"
        placeholder="name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') document.getElementById('ss-attr-add-value')?.focus();
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      <span className="ss-settings__attr-eq">=</span>
      <input
        id="ss-attr-add-value"
        className="ss-settings__attr-input"
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder="value"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          else if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={submit}
      />
    </div>
  );
}
