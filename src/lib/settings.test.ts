import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  DASHBOARD_VISIBILITY_CHANGED_EVENT,
  setCalendarHidden,
  setDashboardHeaderHidden,
  setSlackCtaHidden,
} from './settings';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('dashboard visibility settings', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it.each([
    ['calendar', 'set_calendar_hidden', setCalendarHidden],
    ['slackCta', 'set_slack_cta_hidden', setSlackCtaHidden],
    ['dashboardHeader', 'set_dashboard_header_hidden', setDashboardHeaderHidden],
  ] as const)('notifies the home screen when %s is persisted', async (key, command, setter) => {
    const listener = vi.fn();
    window.addEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, listener);

    await setter(true);

    expect(invokeMock).toHaveBeenCalledWith(command, { hidden: true });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: { key, hidden: true },
    });

    window.removeEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, listener);
  });
});
