import { InfoIcon } from '@/components/icons';
import type {
  ComponentDescriptor,
  ComponentPropDescriptor,
  ComponentSlotDescriptor,
  SourceRef,
  StaticValue,
} from '../../../lib/components/types';
import type { ComponentPreviewPreset } from '../../../lib/components/presets';
import type { RendererA11yFinding } from '../../../lib/components/renderer-session';
import type { RendererFrameEditContext } from '../../../lib/components/editable-surface';
import type { RendererPerformanceSnapshot } from '../../../lib/components/renderer-performance';
import type { ProjectType } from '../../../lib/static-server';
import { EditPanelShell } from '../../edit/EditPanelShell';
import { Button } from '../../primitives/Button';
import { PropertyField } from '../../primitives/PropertyField';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../../primitives/Tabs';
import { TextField } from '../../primitives/TextField';

type RendererSessionState = 'not-started' | 'starting' | 'live' | 'stopping' | 'stopped';
type RendererFrameState = 'idle' | 'loading' | 'ready' | 'error';
type RendererSnapshotState = 'idle' | 'capturing' | 'ready';
type RendererA11yState = 'idle' | 'running' | 'ready';

export interface ComponentEditPanelProps {
  projectType: ProjectType;
  selectedComponent: ComponentDescriptor;
  selectedNode: { generated?: boolean; x: number; y: number; width: number; height: number } | null;
  selectedPreset: ComponentPreviewPreset | null;
  statusBadges: string[];
  rendererEditContext: RendererFrameEditContext | null;
  rendererSessionState: RendererSessionState;
  rendererFrameState: RendererFrameState;
  rendererSurfaceActive: boolean;
  canRunAccessibility: boolean;
  rendererSessionId: string | null;
  rendererFrameElement: HTMLIFrameElement | null;
  rendererFrameError: string | null;
  rendererCircuitOpen: boolean;
  rendererPerformance: RendererPerformanceSnapshot;
  mountedNodeCount: number;
  liveRendererNodeCount: number;
  rendererSnapshotState: RendererSnapshotState;
  rendererSnapshotPath: string | null;
  rendererSnapshotError: string | null;
  rendererA11yFindings: RendererA11yFinding[];
  rendererA11yState: RendererA11yState;
  rendererA11yError: string | null;
  persistError: string | null;
  presetName: string;
  draftPresetProps: Record<string, StaticValue>;
  draftPresetSlots: Record<string, string>;
  onOpenSource: (source: SourceRef) => void;
  onOpenSetup: () => void;
  setupButtonLabel: string;
  setupDisabled: boolean;
  onCreatePreset: () => void;
  onPresetNameChange: (value: string) => void;
  onRenamePreset: () => void;
  onDuplicatePreset: () => void;
  onDeletePreset: () => void;
  onUpdatePresetProp: (prop: ComponentPropDescriptor, value: StaticValue | undefined) => void;
  onUpdatePresetSlot: (slotName: string, value: string) => void;
  onDuplicateFrame: () => void;
  onDeleteFrame: () => void;
  canDeleteFrame: boolean;
  onCaptureSnapshot: () => void;
  onRunAccessibility: () => void;
  onRetryRenderer: () => void;
  onStopRenderer: () => void;
  activeTab: string;
  onTabChange: (value: string) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose?: () => void;
}

function staticValueLabel(value: StaticValue | undefined): string {
  if (!value) return 'Default / unset';
  if (value.kind === 'string') return value.value || 'Empty string';
  if (value.kind === 'number' || value.kind === 'boolean') return String(value.value);
  if (value.kind === 'null') return 'null';
  return JSON.stringify(value);
}

function encodedStaticValue(value: StaticValue): string {
  return JSON.stringify(value);
}

function decodeStaticChoice(value: string, choices: readonly StaticValue[]): StaticValue | undefined {
  return choices.find((choice) => encodedStaticValue(choice) === value);
}

function supportedStaticPropControl(prop: ComponentPropDescriptor): boolean {
  return (
    prop.control === 'text' ||
    prop.control === 'number' ||
    prop.control === 'boolean' ||
    prop.control === 'select' ||
    prop.control === 'asset'
  );
}

function staticValueFromText(prop: ComponentPropDescriptor, value: string): StaticValue | undefined {
  if (prop.control === 'number') {
    const parsed = Number(value);
    return value !== '' && Number.isFinite(parsed) ? { kind: 'number', value: parsed } : undefined;
  }
  return { kind: 'string', value };
}

function selectedElementSource(
  component: ComponentDescriptor,
  context: RendererFrameEditContext | null
): SourceRef | null {
  if (!context) return null;
  return {
    ...component.definition,
    file: context.descendant.file,
    start: context.descendant.start,
    end: context.descendant.end,
    contentHash: context.descendant.contentHash,
  };
}

/** Component-mode content for the shared Edit panel. The renderer and canvas
 * state remain owned by ComponentsWorkspace; this module owns only the UI. */
export function ComponentEditPanel({
  projectType,
  selectedComponent,
  selectedNode,
  selectedPreset,
  statusBadges,
  rendererEditContext,
  rendererSessionState,
  rendererFrameState,
  rendererSurfaceActive,
  canRunAccessibility,
  rendererSessionId,
  rendererFrameElement,
  rendererFrameError,
  rendererCircuitOpen,
  rendererPerformance,
  mountedNodeCount,
  liveRendererNodeCount,
  rendererSnapshotState,
  rendererSnapshotPath,
  rendererSnapshotError,
  rendererA11yFindings,
  rendererA11yState,
  rendererA11yError,
  persistError,
  presetName,
  draftPresetProps,
  draftPresetSlots,
  onOpenSource,
  onOpenSetup,
  setupButtonLabel,
  setupDisabled,
  onCreatePreset,
  onPresetNameChange,
  onRenamePreset,
  onDuplicatePreset,
  onDeletePreset,
  onUpdatePresetProp,
  onUpdatePresetSlot,
  onDuplicateFrame,
  onDeleteFrame,
  canDeleteFrame,
  onCaptureSnapshot,
  onRunAccessibility,
  onRetryRenderer,
  onStopRenderer,
  activeTab,
  onTabChange,
  pinned = false,
  onTogglePin,
  onClose,
}: ComponentEditPanelProps) {
  const selectedSource = selectedElementSource(selectedComponent, rendererEditContext);

  return (
    <EditPanelShell
      context="Component"
      pinned={pinned}
      onTogglePin={onTogglePin}
      onClose={onClose}
      className="components-workspace__component-edit-panel"
      aria-label="Component edit panel"
    >
      <div className="ss-edit-panel__body components-workspace__component-edit-body">
        <Tabs
          className="components-workspace__component-edit-tabs"
          value={activeTab}
          onValueChange={onTabChange}
          mode="panel"
        >
        <TabsList aria-label="Component edit sections">
          <TabsTab value="component">Component</TabsTab>
          <TabsTab value="frame">Frame</TabsTab>
          <TabsTab value="qa">QA</TabsTab>
        </TabsList>

        <TabsPanel value="component" className="components-workspace__component-edit-tab-content">
          <div className="components-workspace__component-summary">
            <h2>{selectedComponent.name}</h2>
            <p className="components-workspace__muted">
              {selectedNode?.generated ? 'Generated default' : 'Saved preset'} · {selectedComponent.dialect}
            </p>
            <div className="components-workspace__status-badges" aria-label="Component status">
              {statusBadges.map((label) => (
                <span key={label} className="components-workspace__status-badge">
                  {label}
                </span>
              ))}
            </div>
          </div>

          {projectType === 'nextjs' && (
            <div className="components-workspace__component-edit-actions">
              <Button
                variant="secondary"
                size="compact"
                onClick={onOpenSetup}
                disabled={setupDisabled}
              >
                {setupButtonLabel}
              </Button>
            </div>
          )}

          <Button variant="secondary" size="compact" onClick={() => onOpenSource(selectedComponent.definition)}>
            Open definition source
          </Button>
          {selectedSource && (
            <Button variant="secondary" size="compact" onClick={() => onOpenSource(selectedSource)}>
              Open selected element source
            </Button>
          )}
          {!selectedPreset && selectedNode && (
            <Button variant="secondary" size="compact" onClick={onCreatePreset}>
              Save as preset
            </Button>
          )}

          {selectedPreset && (
            <div className="components-workspace__preset-actions">
              <TextField
                aria-label="Preset name"
                value={presetName}
                onChange={(event) => onPresetNameChange(event.target.value)}
                maxLength={128}
              />
              <div className="components-workspace__toolbar-actions">
                <Button variant="secondary" size="compact" onClick={onRenamePreset}>
                  Rename preset
                </Button>
                <Button variant="ghost" size="compact" onClick={onDuplicatePreset}>
                  Duplicate preset
                </Button>
                <Button variant="ghost" size="compact" onClick={onDeletePreset}>
                  Delete preset
                </Button>
              </div>
            </div>
          )}

          <div className="components-workspace__field-list">
            {selectedComponent.props.map((prop) => {
              const value = draftPresetProps[prop.name];
              const canEdit = !!selectedPreset && supportedStaticPropControl(prop);
              if (!canEdit || (prop.control === 'select' && !prop.choices?.length)) {
                return (
                  <div key={prop.name} className="components-workspace__field-row">
                    <span>{prop.label ?? prop.name}</span>
                    <PropertyField disabled>
                      {!selectedPreset
                        ? 'Save a preset to set this value'
                        : `Source-only (${prop.typeText ?? 'unknown type'})`}
                    </PropertyField>
                  </div>
                );
              }
              if (prop.control === 'select' && prop.choices?.length) {
                return (
                  <label key={prop.name} className="components-workspace__field-row">
                    <span>{prop.label ?? prop.name}</span>
                    <select
                      aria-label={`Set preset ${prop.name}`}
                      value={value ? encodedStaticValue(value) : ''}
                      onChange={(event) => onUpdatePresetProp(prop, decodeStaticChoice(event.target.value, prop.choices ?? []))}
                    >
                      <option value="">Default / unset</option>
                      {prop.choices.map((choice) => (
                        <option key={encodedStaticValue(choice)} value={encodedStaticValue(choice)}>
                          {staticValueLabel(choice)}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              }
              if (prop.control === 'boolean') {
                return (
                  <label key={prop.name} className="components-workspace__field-row">
                    <span>{prop.label ?? prop.name}</span>
                    <select
                      aria-label={`Set preset ${prop.name}`}
                      value={value?.kind === 'boolean' ? String(value.value) : ''}
                      onChange={(event) =>
                        onUpdatePresetProp(
                          prop,
                          event.target.value === ''
                            ? undefined
                            : { kind: 'boolean', value: event.target.value === 'true' }
                        )
                      }
                    >
                      <option value="">Default / unset</option>
                      <option value="true">True</option>
                      <option value="false">False</option>
                    </select>
                  </label>
                );
              }
              return (
                <label key={prop.name} className="components-workspace__field-row">
                  <span>{prop.label ?? prop.name}</span>
                  <TextField
                    aria-label={`Set preset ${prop.name}`}
                    type={prop.control === 'number' ? 'number' : 'text'}
                    value={value?.kind === 'string' || value?.kind === 'number' ? String(value.value) : ''}
                    placeholder="Default / unset"
                    onChange={(event) => onUpdatePresetProp(prop, staticValueFromText(prop, event.target.value))}
                  />
                </label>
              );
            })}
            {selectedComponent.slots.map((slot: ComponentSlotDescriptor) => (
              <label key={slot.name} className="components-workspace__field-row">
                <span>{slot.name} slot</span>
                {selectedPreset && !slot.scoped ? (
                  <TextField
                    aria-label={`Set preset ${slot.name} slot`}
                    value={draftPresetSlots[slot.name] ?? ''}
                    placeholder="Plain text only"
                    onChange={(event) => onUpdatePresetSlot(slot.name, event.target.value)}
                  />
                ) : (
                  <PropertyField disabled>
                    {slot.scoped ? 'Scoped/runtime slot' : 'Save a preset for static text'}
                  </PropertyField>
                )}
              </label>
            ))}
            {selectedComponent.props.length === 0 && selectedComponent.slots.length === 0 && (
              <p className="components-workspace__muted">No declared props or slots.</p>
            )}
          </div>

          <div className="components-workspace__component-edit-note">
            <InfoIcon size={14} aria-hidden="true" /> Edit main is disabled until a framework-native
            renderer proves an exact descendant source range.
          </div>
          <div className="components-workspace__toolbar-actions">
            <Button variant="secondary" size="compact" disabled={!selectedNode} onClick={onDuplicateFrame}>
              Duplicate frame
            </Button>
            <Button variant="ghost" size="compact" disabled={!canDeleteFrame} onClick={onDeleteFrame}>
              Delete frame
            </Button>
          </div>
        </TabsPanel>

        <TabsPanel value="frame" className="components-workspace__component-edit-tab-content">
          <div className="components-workspace__field-list">
            <div className="components-workspace__field-row">
              <span>Canvas position</span>
              <code>{Math.round(selectedNode?.x ?? 0)}, {Math.round(selectedNode?.y ?? 0)}</code>
            </div>
            <div className="components-workspace__field-row">
              <span>Frame size</span>
              <code>{Math.round(selectedNode?.width ?? 0)} × {Math.round(selectedNode?.height ?? 0)}</code>
            </div>
            <div className="components-workspace__component-edit-note">
              <InfoIcon size={14} aria-hidden="true" /> Frame layout is presentation-only and never changes project source.
            </div>
          </div>
        </TabsPanel>

        <TabsPanel value="qa" className="components-workspace__component-edit-tab-content">
          <div className="components-workspace__field-row">
            <span>Renderer session</span>
            <code>{rendererSessionState}</code>
          </div>
          <div className="components-workspace__field-row">
            <span>Selected frame</span>
            <code>{rendererFrameState}</code>
          </div>
          <div className="components-workspace__field-row">
            <span>Editable surface</span>
            <code>{rendererSurfaceActive ? 'negotiated' : 'inactive'}</code>
          </div>
          {import.meta.env.DEV && (
            <div className="components-workspace__component-edit-note">
              <InfoIcon size={14} aria-hidden="true" /> Canvas counters: {mountedNodeCount} mounted · {liveRendererNodeCount} live iframe
              {rendererPerformance.inputToTransformMs === null
                ? ''
                : ` · ${rendererPerformance.inputToTransformMs}ms input→transform`}
              {` · ${rendererPerformance.longFrameCount} long frame${rendererPerformance.longFrameCount === 1 ? '' : 's'}`}
            </div>
          )}
          {rendererFrameError && <p className="components-workspace__error">{rendererFrameError}</p>}
          {rendererCircuitOpen && (
            <p className="components-workspace__error">Renderer retries are paused after repeated failures for this frame.</p>
          )}
          <Button
            variant="secondary"
            size="compact"
            disabled={!rendererSessionId || rendererFrameState !== 'ready' || !rendererFrameElement || rendererSnapshotState === 'capturing'}
            onClick={onCaptureSnapshot}
          >
            {rendererSnapshotState === 'capturing' ? 'Capturing snapshot…' : 'Capture snapshot'}
          </Button>
          {rendererSnapshotPath && (
            <div className="components-workspace__component-edit-note" role="status">
              Snapshot saved by Ship Studio: <code>{rendererSnapshotPath}</code>
            </div>
          )}
          {rendererSnapshotError && <p className="components-workspace__error">{rendererSnapshotError}</p>}
          <div className="components-workspace__field-row">
            <span>Accessibility</span>
            <code>{rendererA11yState}</code>
          </div>
          <Button
            variant="secondary"
            size="compact"
            disabled={
              !canRunAccessibility ||
              !rendererSessionId ||
              rendererFrameState !== 'ready' ||
              !rendererSurfaceActive ||
              rendererA11yState === 'running'
            }
            onClick={onRunAccessibility}
          >
            {rendererA11yState === 'running' ? 'Inspecting accessibility…' : 'Run accessibility check'}
          </Button>
          {rendererA11yError && <p className="components-workspace__error">{rendererA11yError}</p>}
          {rendererA11yState === 'ready' && (
            <div className="components-workspace__component-edit-note" role="status">
              {rendererA11yFindings.length === 0
                ? 'No bounded accessibility findings were returned.'
                : `${rendererA11yFindings.length} accessibility finding${rendererA11yFindings.length === 1 ? '' : 's'}.`}
            </div>
          )}
          {rendererA11yFindings.length > 0 && (
            <ul className="components-workspace__qa-findings">
              {rendererA11yFindings.map((finding) => (
                <li key={`${finding.id}-${finding.elementRef ?? ''}`}>
                  <strong>{finding.impact}</strong> {finding.message}
                  {finding.elementRef && <code>{finding.elementRef}</code>}
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="ghost"
            size="compact"
            disabled={!rendererSessionId || rendererSessionState === 'stopping' || rendererFrameState !== 'error'}
            onClick={onRetryRenderer}
          >
            Retry renderer
          </Button>
          <Button
            variant="ghost"
            size="compact"
            disabled={!rendererSessionId || rendererSessionState === 'stopping'}
            onClick={onStopRenderer}
          >
            Stop renderer
          </Button>
          <div className="components-workspace__component-edit-note">
            <InfoIcon size={14} aria-hidden="true" /> Baseline comparison and source-linked accessibility fixes remain separate follow-up capabilities. Snapshot capture and bounded accessibility inspection use the active renderer frame.
          </div>
        </TabsPanel>
        </Tabs>
        {persistError && <p className="components-workspace__error">{persistError}</p>}
      </div>
    </EditPanelShell>
  );
}
