import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_PROMPT_STAGED_MESSAGE } from '../../lib/agentPromptHandoff';

// Keep xterm out of jsdom. Preview's diagnostics panel owns the real terminal
// view, which is unrelated to the handoff completion behavior exercised here.
vi.mock('../terminal/DevServerLogs', () => ({ DevServerLogs: () => null }));

const { trackEventMock } = vi.hoisted(() => ({ trackEventMock: vi.fn() }));

vi.mock('../../lib/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/analytics')>();
  return { ...actual, trackEvent: trackEventMock };
});

import { completePreviewFixHandoff } from './Preview';

describe('Preview fix handoff feedback', () => {
  const analytics = {
    has_logs: true,
    is_static: false,
    reason: 'server-down' as const,
    process_gone: true,
  };

  beforeEach(() => {
    trackEventMock.mockClear();
  });

  it('does not show success or record analytics when the route rejects the prompt', () => {
    const showToast = vi.fn();

    completePreviewFixHandoff(false, analytics, showToast);

    expect(showToast).not.toHaveBeenCalled();
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('reports an accepted Chat draft without implying it was sent', () => {
    const showToast = vi.fn();

    completePreviewFixHandoff('chat-draft', analytics, showToast);

    expect(showToast).toHaveBeenCalledWith(CHAT_PROMPT_STAGED_MESSAGE, 'success');
    expect(trackEventMock).toHaveBeenCalledWith('preview_fix_with_agent', analytics);
  });
});
