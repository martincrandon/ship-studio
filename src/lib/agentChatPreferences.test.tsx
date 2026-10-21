import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentChatPreferences } from '../hooks/useAgentChatPreferences';
import { clearActiveAgentWorkspaceView } from './agentChatPreferences';

const projectPath = '/workspace/preferences-contract';
const defaultKey = 'shipstudio.agentChat.defaultView';
const projectKey = `shipstudio.agentChat.projectView:${encodeURIComponent(projectPath)}`;

beforeEach(() => {
  localStorage.removeItem(defaultKey);
  localStorage.removeItem(projectKey);
  clearActiveAgentWorkspaceView(projectPath);
});

describe('Agent Chat view preferences', () => {
  it('starts a project in Terminal when no preference has been saved', () => {
    const { result } = renderHook(() => useAgentChatPreferences(projectPath));

    expect(result.current.defaultView).toBe('terminal');
    expect(result.current.projectView).toBeNull();
    expect(result.current.view).toBe('terminal');
    expect(result.current.isUsingDefault).toBe(true);
  });

  it('lets a project override the Experimental default', () => {
    const { result } = renderHook(() => useAgentChatPreferences(projectPath));

    act(() => {
      result.current.setDefaultView('chat');
      result.current.setProjectView('terminal');
    });

    expect(result.current.defaultView).toBe('chat');
    expect(result.current.projectView).toBe('terminal');
    expect(result.current.view).toBe('terminal');
    expect(result.current.isUsingDefault).toBe(false);
  });

  it('clears a project override when Use default is selected', () => {
    const { result } = renderHook(() => useAgentChatPreferences(projectPath));

    act(() => {
      result.current.setDefaultView('chat');
      result.current.setProjectView('terminal');
    });
    act(() => {
      result.current.useDefaultView();
    });

    expect(localStorage.getItem(projectKey)).toBeNull();
    expect(result.current.projectView).toBeNull();
    expect(result.current.view).toBe('chat');
    expect(result.current.isUsingDefault).toBe(true);
  });

  it('keeps the current project view when the global default changes', () => {
    const openProject = renderHook(() => useAgentChatPreferences(projectPath));

    act(() => {
      openProject.result.current.setDefaultView('chat');
    });

    expect(openProject.result.current.defaultView).toBe('chat');
    expect(openProject.result.current.view).toBe('terminal');

    openProject.unmount();
    clearActiveAgentWorkspaceView(projectPath);
    const reopenedProject = renderHook(() => useAgentChatPreferences(projectPath));
    expect(reopenedProject.result.current.view).toBe('chat');
  });
});
