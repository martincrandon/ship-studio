import { useEffect, useState } from 'react';
import { projectUsesReact } from '../lib/edit';
import type { ProjectType } from '../lib/static-server';

/** React is the first native Components adapter; keep unsupported Vite dialects hidden. */
export function useComponentsAvailability(projectPath: string, projectType: ProjectType): boolean {
  const [viteDetection, setViteDetection] = useState<{
    projectPath: string;
    usesReact: boolean;
  } | null>(null);

  useEffect(() => {
    if (projectType !== 'vite' || !projectPath) return;

    let cancelled = false;
    projectUsesReact(projectPath)
      .then((usesReact) => {
        if (!cancelled) setViteDetection({ projectPath, usesReact });
      })
      .catch(() => {
        if (!cancelled) setViteDetection({ projectPath, usesReact: false });
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, projectType]);

  return (
    projectType === 'nextjs' ||
    (projectType === 'vite' &&
      viteDetection?.projectPath === projectPath &&
      viteDetection.usesReact)
  );
}
