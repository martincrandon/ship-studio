import type { ProjectType } from '../lib/static-server';

/**
 * The source catalog has an adapter for each supported web dialect.  The
 * worker is the authority for whether a particular source snapshot contains
 * components; this gate only decides whether the web preview can expose the
 * catalog while that snapshot is being built.  Keeping this list in sync with
 * the project detector makes non-React adapters reachable without guessing
 * that a Vite project uses a specific UI framework.
 */
export function useComponentsAvailability(_projectPath: string, projectType: ProjectType): boolean {
  return (
    projectType === 'nextjs' ||
    projectType === 'sveltekit' ||
    projectType === 'astro' ||
    projectType === 'nuxt' ||
    projectType === 'vite' ||
    projectType === 'statichtml' ||
    projectType === 'shopifytheme' ||
    projectType === 'generic'
  );
}
