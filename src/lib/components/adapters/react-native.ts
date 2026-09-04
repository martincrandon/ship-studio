import { ReactComponentAdapter } from './react';
import { isReactSourcePath, normalizeProjectPath } from './react-helpers';
import { parseReactFile } from './react-parser';
import { REACT_NATIVE_COMPONENT_PLAN_PARSER_TOKEN, validateReactMutation } from '../mutation';
import type {
  AdapterGraph,
  ComponentAdapter,
  DetectionContext,
  GraphContext,
  EditComponentPropInputWithContext,
  InsertComponentInputWithContext,
  ParseContext,
  ParsedComponentFile,
  RawImportEdge,
  ResolveContext,
  ResolvedImportEdge,
} from './types';
import type {
  ComponentBinding,
  ComponentCapabilities,
  ComponentDescriptor,
  ComponentIndex,
  ComponentInstance,
  MutationResult,
  MutationValidationInput,
  MutationValidationResult,
  SelectionBindingInput,
  SourceFileSnapshot,
} from '../types';

export function reactNativeCapabilities(): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
    instanceBinding: false,
    // Source-only JSX edits are safe when driven from an exact catalog usage;
    // visual selection and native runtime writes remain separate capabilities.
    place: true,
    editStaticProps: true,
    editSlots: false,
    editMain: false,
    componentTreeBoundary: false,
    focusedVisualEditing: false,
    duplicateDefinition: false,
    renameDefinition: false,
    deleteDefinition: false,
    extract: false,
    isolatedPreview: false,
  };
}

function nativeId(id: string): string {
  return id.startsWith('react:') ? `react-native:${id.slice('react:'.length)}` : id;
}

function transformDescriptor(descriptor: ComponentDescriptor): ComponentDescriptor {
  return {
    ...descriptor,
    id: nativeId(descriptor.id),
    dialect: 'react-native',
    capabilities: reactNativeCapabilities(),
  };
}

/**
 * React Native intentionally reuses the TypeScript/JSX source parser, but it
 * publishes a separate dialect and never advertises web DOM mutation. This
 * keeps Metro/runtime binding work independent from the web editor roadmap.
 */
export class ReactNativeComponentAdapter implements ComponentAdapter {
  readonly dialect = 'react-native' as const;
  readonly capabilities = reactNativeCapabilities();
  private readonly react = new ReactComponentAdapter();

  detect(context: DetectionContext) {
    const detected =
      context.projectType === 'reactnative' &&
      context.files.some((file) => isReactSourcePath(file.file));
    return {
      detected,
      confidence: detected ? ('high' as const) : ('low' as const),
      diagnostics: detected
        ? []
        : [
            {
              code: 'react-native-not-project',
              severity: 'info' as const,
              message:
                'React Native source indexing is enabled only for a detected React Native project.',
            },
          ],
    };
  }

  accepts(path: string): boolean {
    return isReactSourcePath(path);
  }

  parseFile(file: SourceFileSnapshot, context: ParseContext): ParsedComponentFile {
    return parseReactFile(file, context.knownFiles);
  }

  resolveImport(edge: RawImportEdge, context: ResolveContext): ResolvedImportEdge {
    return this.react.resolveImport(edge, context);
  }

  buildUsageGraph(files: ParsedComponentFile[], context: GraphContext): AdapterGraph {
    const graph = this.react.buildUsageGraph(files, context);
    const ids = new Map(
      graph.components.map((component) => [component.id, nativeId(component.id)])
    );
    const components = graph.components.map(transformDescriptor);
    const instances: ComponentInstance[] = graph.instances.map((instance) => {
      const componentId = ids.get(instance.componentId) ?? nativeId(instance.componentId);
      return {
        ...instance,
        id: instance.id.replace(instance.componentId, componentId),
        componentId,
        containingComponentId: instance.containingComponentId
          ? (ids.get(instance.containingComponentId) ?? nativeId(instance.containingComponentId))
          : null,
      };
    });
    return { ...graph, components, instances };
  }

  bindSelection(input: SelectionBindingInput, index: ComponentIndex): ComponentBinding {
    const candidates = input.candidates?.length
      ? input.candidates.filter(
          (candidate) => candidate.renderer === 'react-native' || candidate.renderer === 'unknown'
        )
      : input.file && input.line
        ? [
            {
              renderer: 'react-native' as const,
              file: input.file,
              line: input.line,
              column: input.column ?? 1,
              symbolHint: input.symbolHint ?? null,
              runtimeKey: null,
            },
          ]
        : [];
    const matches = index.instances.filter((instance) =>
      candidates.some(
        (candidate) =>
          normalizeProjectPath(candidate.file) === normalizeProjectPath(instance.invocation.file) &&
          candidate.line === instance.invocation.line &&
          (!candidate.symbolHint ||
            index.components.find((component) => component.id === instance.componentId)?.name ===
              candidate.symbolHint) &&
          (!input.sourceHash || input.sourceHash === instance.invocation.contentHash)
      )
    );
    if (matches.length === 1) {
      const instance = matches[0];
      const component = index.components.find((candidate) => candidate.id === instance.componentId);
      if (component) {
        return {
          confidence: 'sourceAnchored',
          componentId: component.id,
          source: component.definition,
          candidates: [
            {
              componentId: component.id,
              source: component.definition,
              confidence: 'sourceAnchored',
            },
          ],
          diagnostics: [
            {
              code: 'react-native-runtime-unbound',
              severity: 'info',
              message:
                'React Native source provenance is available; Metro runtime binding is not connected yet.',
            },
          ],
        };
      }
    }
    if (matches.length > 1) {
      return {
        confidence: 'ambiguous',
        candidates: matches.map((instance) => ({
          componentId: instance.componentId,
          instanceId: instance.id,
          source: instance.invocation,
          confidence: 'sourceAnchored' as const,
        })),
        diagnostics: [
          {
            code: 'react-native-runtime-unbound',
            severity: 'info',
            message: 'React Native runtime binding is not connected yet.',
          },
        ],
      };
    }
    return {
      confidence: 'none',
      candidates: [],
      diagnostics: [
        {
          code: 'react-native-runtime-unbound',
          severity: 'info',
          message: 'React Native runtime binding is not connected yet.',
        },
      ],
    };
  }

  planInsert(input: InsertComponentInputWithContext, index: ComponentIndex): MutationResult {
    return nativeMutation(this.react.planInsert(input, index));
  }

  planPropEdit(input: EditComponentPropInputWithContext, index: ComponentIndex): MutationResult {
    return nativeMutation(this.react.planPropEdit(input, index));
  }

  validateMutation(input: MutationValidationInput): MutationValidationResult {
    return validateReactMutation(input, 'react-native');
  }
}

function nativeMutation(result: MutationResult): MutationResult {
  if (result.status === 'refused') return result;
  return {
    status: 'planned',
    plan: {
      ...result.plan,
      dialect: 'react-native',
      parserToken: REACT_NATIVE_COMPONENT_PLAN_PARSER_TOKEN,
    },
  };
}

export function createReactNativeAdapter(): ReactNativeComponentAdapter {
  return new ReactNativeComponentAdapter();
}
