import { useCallback, useMemo, useRef, useState } from 'react';
import { toCss } from '../../lib/color';

export const COLOR_PICKER_RECENT_LIMIT = 9;
const STORAGE_PREFIX = 'shipstudio.color-picker.recent.v1';

function storageKey(projectPath: string | undefined): string | null {
  return projectPath ? `${STORAGE_PREFIX}:${encodeURIComponent(projectPath)}` : null;
}

function normalizeRecent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const colors: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const normalized = toCss(candidate);
    if (!normalized || colors.includes(normalized)) continue;
    colors.push(normalized);
    if (colors.length >= COLOR_PICKER_RECENT_LIMIT) break;
  }
  return colors;
}

function loadRecent(projectPath: string | undefined): string[] {
  const key = storageKey(projectPath);
  if (!key || typeof window === 'undefined') return [];
  try {
    const serialized = window.localStorage.getItem(key);
    return serialized ? normalizeRecent(JSON.parse(serialized)) : [];
  } catch {
    return [];
  }
}

/** Recently committed picker colors, isolated by the owning project path. */
export function useColorPickerRecent(projectPath?: string) {
  const [history, setHistory] = useState(() => ({
    projectPath,
    colors: loadRecent(projectPath),
  }));
  const colors = useMemo(
    () => (history.projectPath === projectPath ? history.colors : loadRecent(projectPath)),
    [history, projectPath]
  );
  const colorsRef = useRef(history.colors);
  const currentProjectRef = useRef(projectPath);

  const recordColor = useCallback(
    (color: string) => {
      const normalized = toCss(color);
      if (!normalized) return;
      if (currentProjectRef.current !== projectPath) {
        currentProjectRef.current = projectPath;
        colorsRef.current = loadRecent(projectPath);
      }
      const next = [
        normalized,
        ...colorsRef.current.filter((recent) => recent !== normalized),
      ].slice(0, COLOR_PICKER_RECENT_LIMIT);
      colorsRef.current = next;
      setHistory({ projectPath, colors: next });

      const key = storageKey(projectPath);
      if (!key || typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private browsing and quota limits should not block the picker.
      }
    },
    [projectPath]
  );

  return { colors, recordColor };
}
