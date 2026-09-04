import type {
  ComponentBoundaryHint,
  ComponentDescriptor,
  ComponentIndex,
  ComponentInstance,
  ComponentRenderRoot,
  RawComponentTreeNode,
} from '../types';

interface Options {
  /** Runtime owner frames already proved these instances. */
  excludedInstanceIds?: ReadonlySet<string>;
}

/**
 * Build exact-looking boundaries for the narrow Next Server Component case
 * where the source and rendered DOM provide the same unique proof:
 *
 * - the project is a Next App Router project;
 * - the source file is not marked `use client`;
 * - the component has one indexed invocation;
 * - the component always returns one intrinsic root with static identity
 *   attributes; and
 * - exactly one current DOM node matches that root signature.
 *
 * Next does not retain a browser Fiber owner for every Server Component. This
 * fallback therefore refuses dynamic, repeated, ambiguous, or unmarked roots
 * instead of guessing a component boundary from a tag alone. It never adds a
 * DOM wrapper or mutates the project.
 */
export function collectNextServerComponentBoundaries(
  tree: RawComponentTreeNode,
  index: ComponentIndex,
  options: Options = {}
): ComponentBoundaryHint[] {
  if (index.profile.projectType !== 'nextjs') return [];

  const eligible = index.components.filter(
    (component): component is ComponentDescriptor & { renderRoot: ComponentRenderRoot } =>
      component.dialect === 'react' &&
      component.isClientModule === false &&
      component.usageCount === 1 &&
      !!component.renderRoot &&
      !options.excludedInstanceIds?.has(
        index.instances.find((instance) => instance.componentId === component.id)?.id ?? ''
      )
  );
  const uniqueSignatures = uniqueSignatureComponents(eligible);
  const nodes = collectNodes(tree);
  const boundaries: ComponentBoundaryHint[] = [];

  for (const component of eligible) {
    const signature = signatureForRoot(component.renderRoot);
    if (uniqueSignatures.get(signature)?.length !== 1) continue;
    const instance = singleInstanceFor(index, component.id);
    if (!instance) continue;
    const matches = nodes.filter((node) => matchesRoot(node, component.renderRoot));
    if (matches.length !== 1) continue;
    boundaries.push({
      key: instance.id,
      componentId: component.id,
      instanceId: instance.id,
      confidence: 'exact',
      hostNodeIds: [matches[0].id],
      definition: component.definition,
      invocation: instance.invocation,
      indexRevision: index.revision,
    });
  }

  return boundaries;
}

function uniqueSignatureComponents(
  components: readonly (ComponentDescriptor & { renderRoot: ComponentRenderRoot })[]
): Map<string, ComponentDescriptor[]> {
  const grouped = new Map<string, ComponentDescriptor[]>();
  for (const component of components) {
    const signature = signatureForRoot(component.renderRoot);
    const current = grouped.get(signature) ?? [];
    current.push(component);
    grouped.set(signature, current);
  }
  return grouped;
}

function singleInstanceFor(index: ComponentIndex, componentId: string): ComponentInstance | null {
  const instances = index.instances.filter((instance) => instance.componentId === componentId);
  return instances.length === 1 ? instances[0] : null;
}

function collectNodes(root: RawComponentTreeNode): RawComponentTreeNode[] {
  const nodes: RawComponentTreeNode[] = [];
  const visit = (node: RawComponentTreeNode) => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return nodes;
}

function signatureForRoot(root: ComponentRenderRoot): string {
  return `${root.tag}|${root.id ?? ''}|${root.classTokens.join(' ')}`;
}

function matchesRoot(node: RawComponentTreeNode, root: ComponentRenderRoot): boolean {
  if (node.tag.toLowerCase() !== root.tag) return false;
  if ((node.idAttr ?? null) !== root.id) return false;
  const classTokens = [...new Set(node.cls.split(/\s+/).filter(Boolean))].sort();
  return (
    classTokens.length === root.classTokens.length &&
    classTokens.every((token, index) => token === root.classTokens[index])
  );
}
