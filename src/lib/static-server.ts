/**
 * Frontend wrapper for the built-in static file server and project type detection.
 *
 * Used for plain HTML/CSS/JS projects that don't have a framework dev server.
 *
 * @module lib/static-server
 */

import { invoke } from '@tauri-apps/api/core';

/** Detected project type from the Rust backend */
export type ProjectType =
  | 'nextjs'
  | 'sveltekit'
  | 'astro'
  | 'nuxt'
  | 'vite'
  | 'statichtml'
  | 'reactnative'
  | 'flutter'
  | 'shopifytheme'
  | 'generic'
  | 'unknown';

/** Native mobile project types (previewed via a device mirror, not a web iframe). */
export const MOBILE_PROJECT_TYPES: readonly ProjectType[] = ['reactnative', 'flutter'];

/** Whether a detected project type is a native mobile app. */
export function isMobileProjectType(type: ProjectType): boolean {
  return MOBILE_PROJECT_TYPES.includes(type);
}

/**
 * Whether a project gets the web (iframe) Preview pane.
 *
 * The rule (issue #691):
 * - Detected web frameworks (next/vite/astro/…, static HTML, Shopify themes)
 *   always have a preview.
 * - `generic` projects have a preview ONLY when they have a dev command to
 *   run — a configured custom command (#691), or the package.json's own
 *   `dev` script (#1105; e.g. `turbo run dev` at a pnpm/Turborepo root).
 *   An Nx/monorepo root (or any tooling-only package.json project) detects
 *   as `generic`, but once a dev command runs the server is live, so the
 *   Preview tab must appear. Generic projects with neither (script
 *   collections, Rust CLIs, …) still hide the Preview.
 * - `unknown` and native mobile types never get the web preview (mobile uses
 *   the device mirror instead).
 */
export function hasWebPreview(type: ProjectType, genericDevCommand: string | null): boolean {
  if (type === 'generic') {
    return genericDevCommand !== null && genericDevCommand.trim() !== '';
  }
  return type !== 'unknown' && !isMobileProjectType(type);
}

/** Detect the project type for a given project path */
export async function detectProjectType(projectPath: string): Promise<ProjectType> {
  return invoke<ProjectType>('detect_project_type_command', { projectPath });
}

/** Start the built-in static file server, returns the port it's listening on */
export async function startStaticServer(
  windowLabel: string,
  projectPath: string,
  servePath: string
): Promise<number> {
  return invoke<number>('start_static_server', { windowLabel, projectPath, servePath });
}

/** Stop the static file server for a window */
export async function stopStaticServer(windowLabel: string, projectPath: string): Promise<void> {
  return invoke<void>('stop_static_server', { windowLabel, projectPath });
}
