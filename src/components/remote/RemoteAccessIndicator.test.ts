import { describe, expect, it } from 'vitest';
import { indicatorState } from './RemoteAccessIndicator';
import type { RemoteAccessBrief } from '../../lib/remoteAccess';

const now = 1_000_000_000;
const brief = (over: Partial<RemoteAccessBrief> = {}): RemoteAccessBrief => ({
  enabled: true,
  serverRunning: true,
  keepAwake: true,
  power: { hasBattery: true, onAc: true, batteryPercent: 90, charging: true },
  lidClosedMode: false,
  activity: { lastRequestMs: null, lastClient: null, rejectedRequests: 0 },
  ...over,
});

describe('indicatorState', () => {
  it('stays visible while off, so people can find the feature', () => {
    expect(indicatorState(brief({ enabled: false }), now)).toMatchObject({
      tone: 'off',
      line: 'Remote access off',
    });
  });

  it('is calm and says who last connected', () => {
    expect(indicatorState(brief(), now)).toMatchObject({ tone: 'ok', line: 'Remote on' });
    expect(
      indicatorState(
        brief({
          activity: { lastRequestMs: now - 120_000, lastClient: 'grok', rejectedRequests: 0 },
        }),
        now
      )?.line
    ).toBe('Remote on · grok 2 min ago');
  });

  it('turns amber on battery, with the level', () => {
    expect(
      indicatorState(
        brief({ power: { hasBattery: true, onAc: false, batteryPercent: 37, charging: false } }),
        now
      )
    ).toMatchObject({ tone: 'warn', line: 'Remote on · battery 37%' });
  });

  it('turns red when the server is not running', () => {
    expect(indicatorState(brief({ serverRunning: false }), now)?.tone).toBe('down');
  });
});
