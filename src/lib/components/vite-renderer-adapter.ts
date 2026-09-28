import type { RendererRegistryResult } from './renderer-registry';

export interface ViteRendererSpikeInput {
  projectFiles: readonly string[];
  registry: Pick<RendererRegistryResult, 'entries'>;
  devServerOrigin?: string;
}

export interface ViteRendererSpikeResult {
  supported: false;
  detectedConfigFiles: string[];
  reason: string;
  remediation: string;
}

/**
 * Vite cannot be treated like a framework route: whether a generated entry
 * under `.shipstudio/component-renderer` is transformed depends on the
 * project's config, root, aliases, base, plugins, and middleware. Until a
 * reviewed plugin/config contract exists, the safe spike is an explicit
 * refusal rather than silently relying on Vite defaults.
 */
export function spikeViteRendererHost(input: ViteRendererSpikeInput): ViteRendererSpikeResult {
  const detectedConfigFiles = input.projectFiles
    .map(normalizeProjectPath)
    .filter((file) => /^vite\.config\.(?:[cm]?js|[cm]?ts)$/.test(file.split('/').pop() ?? ''))
    .sort();
  const configDetail =
    detectedConfigFiles.length > 0
      ? `Detected ${detectedConfigFiles.join(', ')}.`
      : 'No Vite config file was present in the source snapshot.';
  const registryDetail =
    input.registry.entries.length > 0
      ? 'The static registry is available but does not prove dev-server transformation.'
      : 'No supported registry entries are available.';
  const originDetail = input.devServerOrigin
    ? ` The detected dev-server origin is ${input.devServerOrigin}, but its base and plugin graph were not executed.`
    : '';
  return {
    supported: false,
    detectedConfigFiles,
    reason: `${configDetail} ${registryDetail}${originDetail} Vite renderer hosting is not accepted without a reviewed integration.`,
    remediation:
      'Keep Vite catalog-only and review a scoped Vite plugin/config approach that serves the generated entry, preserves aliases/styles/assets/HMR, and does not weaken project or session origin checks. Ship Studio will not edit vite.config.* automatically.',
  };
}

function normalizeProjectPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
