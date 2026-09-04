import { isRouteSpecialFile, normalizeProjectPath } from './adapters/react-helpers';
import type { Resolution, UsageReport, UsageSite, FileKind } from '../edit';
import type { ComponentDescriptor, ComponentIndex, SourceRef } from './types';

/** Map an indexed source file to the same scope labels used by UsageScope. */
function fileKind(file: string, descriptor?: ComponentDescriptor): FileKind {
  const normalized = normalizeProjectPath(file);
  const base = normalized
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/, '')
    .toLowerCase();
  if (descriptor?.kind === 'layout' || base === 'layout' || base === 'template') return 'layout';
  return isRouteSpecialFile(normalized) ? 'page' : 'component';
}

function lineContains(source: SourceRef, line: number): boolean {
  return line >= source.line && line <= source.end;
}

function rangeContains(
  source: SourceRef,
  resolution: Extract<Resolution, { status: 'resolved' }>
): boolean {
  const start = resolution.source_start;
  const end = resolution.source_end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return lineContains(source, resolution.line);
  }
  const startOffset = start as number;
  const endOffset = end as number;
  return (
    startOffset >= source.start &&
    endOffset <= source.end &&
    endOffset > startOffset &&
    (!resolution.source_hash || resolution.source_hash === source.contentHash)
  );
}

/**
 * Build the legacy UsageScope DTO from the immutable component index.
 *
 * This is intentionally informational: it only reports definitions and
 * invocations already returned by the index. A missing match returns null so
 * callers can retain the old backend fallback during the rollout.
 */
export function usageReportForResolution(
  index: ComponentIndex | null | undefined,
  resolution: Resolution | null | undefined
): UsageReport | null {
  if (!index || resolution?.status !== 'resolved') return null;
  const file = normalizeProjectPath(resolution.file);
  const matches = index.components.filter(
    (component) =>
      normalizeProjectPath(component.definition.file) === file &&
      rangeContains(component.definition, resolution)
  );
  const component = [...matches].sort(
    (left, right) =>
      left.definition.end - left.definition.start - (right.definition.end - right.definition.start)
  )[0];
  if (!component) return null;

  const sites: UsageSite[] = index.instances
    .filter((instance) => instance.componentId === component.id)
    .map((instance) => ({
      file: instance.invocation.file,
      line: instance.invocation.line,
      kind: fileKind(instance.invocation.file),
    }));

  return {
    component: component.name,
    selfKind: fileKind(component.definition.file, component),
    sites,
  };
}
