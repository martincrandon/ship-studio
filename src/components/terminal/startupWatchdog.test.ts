/**
 * Tests for the PTY startup watchdog policy (issue #158).
 *
 * The behaviour that matters: a spawned-but-silent PTY gets exactly one
 * automatic respawn; a second silent run surfaces the error; output or
 * unmount disarms the watchdog entirely. Both the workspace terminal
 * (#384) and the onboarding terminal (#245) run on this one policy.
 */

import { describe, it, expect } from 'vitest';
import {
  decideStartupTimeoutAction,
  RESPAWN_GRACE_MS,
  shouldArmStartupWatchdog,
  STARTUP_TIMEOUT_MS,
} from './startupWatchdog';

describe('decideStartupTimeoutAction', () => {
  it('does nothing once output has been received', () => {
    expect(
      decideStartupTimeoutAction({ receivedOutput: true, mounted: true, autoRespawnUsed: false })
    ).toBe('none');
    // Output wins even if the respawn budget is already spent.
    expect(
      decideStartupTimeoutAction({ receivedOutput: true, mounted: true, autoRespawnUsed: true })
    ).toBe('none');
  });

  it('does nothing after unmount', () => {
    expect(
      decideStartupTimeoutAction({ receivedOutput: false, mounted: false, autoRespawnUsed: false })
    ).toBe('none');
    expect(
      decideStartupTimeoutAction({ receivedOutput: false, mounted: false, autoRespawnUsed: true })
    ).toBe('none');
  });

  it('respawns once when the first spawn is silent', () => {
    expect(
      decideStartupTimeoutAction({ receivedOutput: false, mounted: true, autoRespawnUsed: false })
    ).toBe('respawn');
  });

  it('shows the error when the respawn is also silent (no retry loop)', () => {
    expect(
      decideStartupTimeoutAction({ receivedOutput: false, mounted: true, autoRespawnUsed: true })
    ).toBe('error');
  });
});

describe('watchdog timings', () => {
  it('keeps the historical windows both terminals were built around', () => {
    // Deliberately pinned: the setup commands are written to print
    // immediately so 10s only trips a wedged spawn, and the user-facing
    // messages in both terminals still say "10 seconds".
    expect(STARTUP_TIMEOUT_MS).toBe(10_000);
    expect(RESPAWN_GRACE_MS).toBe(500);
  });
});

describe('shouldArmStartupWatchdog (issue #1074)', () => {
  it('arms for a genuine spawn that has not printed yet', () => {
    expect(shouldArmStartupWatchdog({ spawned: true, outputBytesAtAttach: 0 })).toBe(true);
  });

  it('never arms when re-attaching to a session the backend already owns', () => {
    // The issue: an agent idling on its login screen after a remount. It is
    // alive and waiting for the user; killing it respawned the same
    // session id and hit "Session ID ... is already in use".
    expect(shouldArmStartupWatchdog({ spawned: false, outputBytesAtAttach: 4096 })).toBe(false);
    // Even a re-attached session with no output is past spawn - not ours to kill.
    expect(shouldArmStartupWatchdog({ spawned: false, outputBytesAtAttach: 0 })).toBe(false);
  });

  it('does not arm once the attach snapshot shows output', () => {
    // Output emitted before the listener subscribed lands only in the
    // snapshot; it still proves the process started.
    expect(shouldArmStartupWatchdog({ spawned: true, outputBytesAtAttach: 12 })).toBe(false);
  });

  it('falls back to the snapshot when the backend does not report spawned', () => {
    expect(shouldArmStartupWatchdog({ spawned: undefined, outputBytesAtAttach: 0 })).toBe(true);
    expect(shouldArmStartupWatchdog({ spawned: undefined, outputBytesAtAttach: 1 })).toBe(false);
  });
});
