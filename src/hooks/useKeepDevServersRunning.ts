import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  getKeepDevServersRunning,
  KEEP_DEV_SERVERS_RUNNING_CHANGED_EVENT,
  KEEP_DEV_SERVERS_RUNNING_LOCAL_CHANGED_EVENT,
} from '../lib/settings';

/** Reads the app-wide preference and keeps every open window in sync. */
export function useKeepDevServersRunning(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const updateSequence = useRef(0);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const handleLocalChange = (event: Event) => {
      const value = (event as CustomEvent<boolean>).detail;
      if (typeof value !== 'boolean') return;
      updateSequence.current += 1;
      setEnabled(value);
    };
    window.addEventListener(KEEP_DEV_SERVERS_RUNNING_LOCAL_CHANGED_EVENT, handleLocalChange);

    void (async () => {
      try {
        // Subscribe before reading persisted state so a write from another
        // window between these operations cannot leave this window stale.
        const stopListening = await listen<boolean>(
          KEEP_DEV_SERVERS_RUNNING_CHANGED_EVENT,
          (event) => {
            updateSequence.current += 1;
            setEnabled(event.payload);
          }
        );
        if (disposed) {
          stopListening();
          return;
        }
        unlisten = stopListening;

        const sequenceAtRead = updateSequence.current;
        const value = await getKeepDevServersRunning();
        if (!disposed && sequenceAtRead === updateSequence.current) setEnabled(value);
      } catch {
        if (!disposed) setEnabled(false);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(KEEP_DEV_SERVERS_RUNNING_LOCAL_CHANGED_EVENT, handleLocalChange);
    };
  }, []);

  return enabled;
}
