import { useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { openUrl } from '@tauri-apps/plugin-opener';
import { CopyIcon } from '@/components/icons';
import { IconButton } from '@/components/primitives/IconButton';
import { useOptionalToast } from '@/contexts/ToastContext';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';

interface AgentChatMarkdownProps {
  text: string;
  className?: string;
}

const PURIFY_OPTIONS = {
  FORBID_TAGS: [
    'img',
    'svg',
    'math',
    'iframe',
    'video',
    'audio',
    'object',
    'embed',
    'button',
    'form',
    'input',
    'textarea',
    'select',
    'option',
  ],
  FORBID_ATTR: ['style', 'srcset'],
};

type MarkdownPart =
  | { kind: 'html'; html: string; key: string }
  | { kind: 'code'; code: string; language: string; key: string };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function markdownParts(markdown: string): MarkdownPart[] {
  const renderer = new marked.Renderer();
  renderer.html = ({ text: rawHtml }) => escapeHtml(rawHtml);
  const parsed = String(marked.parse(markdown, { async: false, gfm: true, renderer }));
  const safe = DOMPurify.sanitize(parsed, PURIFY_OPTIONS);
  const parts: MarkdownPart[] = [];
  const codeBlock = /<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = codeBlock.exec(safe))) {
    if (match.index > cursor) {
      parts.push({ kind: 'html', html: safe.slice(cursor, match.index), key: `html-${index++}` });
    }
    const parsedCode =
      new DOMParser().parseFromString(match[2], 'text/html').body.textContent ?? '';
    parts.push({
      kind: 'code',
      code: parsedCode,
      language: match[1] ?? '',
      key: `code-${index++}`,
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < safe.length || parts.length === 0) {
    parts.push({ kind: 'html', html: safe.slice(cursor), key: `html-${index}` });
  }
  return parts;
}

export function AgentChatMarkdown({ text, className }: AgentChatMarkdownProps) {
  const { copy } = useCopyToClipboard();
  const { showToast } = useOptionalToast();
  const parts = useMemo(() => markdownParts(text), [text]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) {
      void openUrl(href).catch(() => showToast('Could not open that link', 'error'));
    }
  };

  return (
    <div
      className={['agent-chat-markdown', className].filter(Boolean).join(' ')}
      onClick={handleClick}
    >
      {parts.map((part) =>
        part.kind === 'html' ? (
          <div key={part.key} dangerouslySetInnerHTML={{ __html: part.html }} />
        ) : (
          <pre className="agent-chat-markdown__code" key={part.key}>
            <IconButton
              icon={<CopyIcon size={14} />}
              aria-label="Copy code block"
              className="agent-chat-markdown__copy-code"
              size="compact"
              variant="ghost"
              onClick={() => void copy(part.code)}
            />
            <code className={part.language ? `language-${part.language}` : undefined}>
              {part.code}
            </code>
          </pre>
        )
      )}
    </div>
  );
}

export function AgentChatCopyButton({ text }: { text: string }) {
  const { copy, isCopied } = useCopyToClipboard();
  return (
    <IconButton
      icon={<CopyIcon size={14} />}
      className="agent-chat-copy-message"
      aria-label={isCopied ? 'Copied message' : 'Copy message'}
      size="compact"
      variant="ghost"
      onClick={() => void copy(text)}
    />
  );
}
