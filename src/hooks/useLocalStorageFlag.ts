import { useCallback, useEffect, useRef, useState } from 'react';

const FLAG_CHANGED_EVENT = 'ship-studio:local-storage-flag-changed';

function readFlag(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? defaultValue : raw === '1';
  } catch {
    // Private-mode / disabled storage — fall back to the default rather than
    // taking the whole view down.
    return defaultValue;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Non-fatal: the preference just doesn't survive the session.
  }
}

function announceFlagChange(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FLAG_CHANGED_EVENT, { detail: { key, value } }));
}

/**
 * A boolean UI preference persisted in localStorage as '1' / '0'.
 *
 * Panel pins and visibility toggles all repeated the same read-on-mount /
 * write-on-change pair; this centralizes it (and the storage guards).
 *
 * Returns `[value, set, toggle]`.
 */
export function useLocalStorageFlag(
  key: string,
  defaultValue: boolean
): [boolean, (value: boolean) => void, () => void] {
  const [value, setValue] = useState(() => readFlag(key, defaultValue));
  const valueRef = useRef(value);

  useEffect(() => {
    const syncFromStorage = () => {
      const next = readFlag(key, defaultValue);
      valueRef.current = next;
      setValue(next);
    };
    const onLocalChange = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: boolean }>).detail;
      if (detail?.key !== key) return;
      const next = typeof detail.value === 'boolean' ? detail.value : readFlag(key, defaultValue);
      valueRef.current = next;
      setValue(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) syncFromStorage();
    };

    window.addEventListener(FLAG_CHANGED_EVENT, onLocalChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(FLAG_CHANGED_EVENT, onLocalChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [defaultValue, key]);

  const set = useCallback(
    (next: boolean) => {
      valueRef.current = next;
      writeFlag(key, next);
      setValue(next);
      announceFlagChange(key, next);
    },
    [key]
  );

  const toggle = useCallback(() => {
    const next = !valueRef.current;
    valueRef.current = next;
    writeFlag(key, next);
    setValue(next);
    announceFlagChange(key, next);
  }, [key]);

  return [value, set, toggle];
}
