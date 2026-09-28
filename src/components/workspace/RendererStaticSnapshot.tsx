import { useEffect, useState } from 'react';
import { getScreenshotBase64 } from '../../lib/ide';
import { COMPONENT_CANVAS_MAX_LIVE_FRAMES } from '../../lib/components/canvas';
import type { RendererStaticSnapshot } from '../../lib/components/renderer-snapshot-cache';

interface RendererStaticSnapshotProps {
  componentName: string;
  snapshot: RendererStaticSnapshot;
}

const loadedSnapshotSources = new Map<string, string>();
const pendingSnapshotSources = new Map<string, Promise<string>>();

function cacheSnapshotSource(path: string, source: string): void {
  loadedSnapshotSources.delete(path);
  loadedSnapshotSources.set(path, source);

  while (loadedSnapshotSources.size > COMPONENT_CANVAS_MAX_LIVE_FRAMES) {
    const oldestPath = loadedSnapshotSources.keys().next().value;
    if (oldestPath === undefined) return;
    loadedSnapshotSources.delete(oldestPath);
  }
}

/**
 * Loads a static renderer image once and shares the result with every card.
 * Snapshot eviction waits for this promise before removing the live iframe,
 * so the card never has to flash through its loading state during handoff.
 */
export function preloadRendererStaticSnapshot(path: string): Promise<string> {
  const loaded = loadedSnapshotSources.get(path);
  if (loaded) return Promise.resolve(loaded);

  const pending = pendingSnapshotSources.get(path);
  if (pending) return pending;

  const request = getScreenshotBase64(path)
    .then((source) => {
      pendingSnapshotSources.delete(path);
      cacheSnapshotSource(path, source);
      return source;
    })
    .catch((error: unknown) => {
      pendingSnapshotSources.delete(path);
      throw error;
    });
  pendingSnapshotSources.set(path, request);
  return request;
}

/** Displays a captured renderer image without executing project code. */
export function RendererStaticSnapshotView({
  componentName,
  snapshot,
}: RendererStaticSnapshotProps) {
  const initialImageSrc = loadedSnapshotSources.get(snapshot.path) ?? null;
  const [imageSrc, setImageSrc] = useState<string | null>(initialImageSrc);
  const [loadedPath, setLoadedPath] = useState<string | null>(
    initialImageSrc ? snapshot.path : null
  );
  const [failedPath, setFailedPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void preloadRendererStaticSnapshot(snapshot.path)
      .then((source) => {
        if (cancelled) return;
        setImageSrc(source);
        setLoadedPath(snapshot.path);
      })
      .catch(() => {
        if (!cancelled) setFailedPath(snapshot.path);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.path]);

  const failed = failedPath === snapshot.path;
  const loaded =
    loadedSnapshotSources.get(snapshot.path) ?? (loadedPath === snapshot.path ? imageSrc : null);

  if (failed) {
    return (
      <div className="component-canvas-node__body" role="status">
        <strong>Snapshot unavailable</strong>
        <span>The static preview could not be loaded.</span>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="component-canvas-node__body" role="status" aria-busy="true">
        <strong>Loading snapshot…</strong>
      </div>
    );
  }

  return (
    <div className="component-canvas-node__snapshot" data-testid="component-canvas-static-snapshot">
      <img src={loaded} alt={`${componentName} static snapshot`} loading="eager" />
    </div>
  );
}
