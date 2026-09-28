import type { ProjectType } from '../static-server';
import { COMPONENT_RENDERER_FLAGS, type ComponentRendererFlags } from './feature-flags';
import type { RendererRegistryEntry } from './renderer-registry';

export type RendererAdapterKind = 'next' | 'vite' | 'react' | 'unsupported';

export interface RendererReadiness {
  adapter: RendererAdapterKind;
  live: boolean;
  label: string;
  reason: string;
}

export function rendererReadiness(
  projectType: ProjectType,
  entry: RendererRegistryEntry | undefined,
  flags: ComponentRendererFlags = COMPONENT_RENDERER_FLAGS
): RendererReadiness {
  if (!entry) {
    return {
      adapter: 'unsupported',
      live: false,
      label: 'Catalog-only',
      reason: 'This component is not present in the current parser registry.',
    };
  }
  if (!entry.supported) {
    return {
      adapter: 'unsupported',
      live: false,
      label: 'Catalog-only',
      reason: entry.reason ?? 'The component did not pass the renderer registry checks.',
    };
  }
  if (projectType === 'nextjs') {
    const live = flags.nextAppRouter || flags.nextPagesRouter;
    return {
      adapter: 'next',
      live,
      label: live ? 'Renderer ready' : 'Catalog-only',
      reason: live
        ? 'The reviewed Next renderer setup is available; confirm a generated host before rendering.'
        : 'Next renderer adapters are disabled until their App/Pages acceptance matrices pass.',
    };
  }
  if (projectType === 'vite') {
    return {
      adapter: 'vite',
      live: flags.vite,
      label: flags.vite ? 'Renderer ready' : 'Catalog-only',
      reason: flags.vite
        ? 'The Vite renderer is enabled for this project.'
        : 'Vite stays catalog-only until a reviewed plugin/config integration proves entry serving, aliases, styles, assets, HMR, and session-origin safety; Ship Studio will not edit vite.config.* automatically.',
    };
  }
  if (projectType === 'astro') {
    return {
      adapter: 'unsupported',
      live: false,
      label: 'Catalog-only',
      reason:
        'Astro components stay catalog-only until a reviewed Astro renderer adapter preserves the project runtime, integrations, styles, and server/client boundaries.',
    };
  }
  return {
    adapter: 'react',
    live: flags.react,
    label: flags.react ? 'Renderer ready' : 'Catalog-only',
    reason: flags.react
      ? 'The React renderer is enabled for this project.'
      : 'This project type has no accepted framework-native renderer adapter yet.',
  };
}
