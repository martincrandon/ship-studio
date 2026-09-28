import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  CANVAS_DRAG_THRESHOLD_PX,
  type CanvasCameraState,
} from '../../../lib/components/canvas-camera';
import {
  createCanvasGuide,
  deleteCanvasGuide,
  moveCanvasGuide,
  type CanvasGuide,
} from '../../../lib/components/canvas-geometry';
import type { ComponentCanvasGuide } from '../../../lib/components/canvas';
import {
  CANVAS_RULER_THICKNESS_PX,
  canvasRulerMarkerOpacity,
  createCanvasRulerLayout,
  type CanvasRulerAxis,
  type CanvasRulerBounds,
} from '../../../lib/components/canvas-rulers';

type GuideOrientation = ComponentCanvasGuide['orientation'];

interface CanvasPointerLike {
  clientX: number;
  clientY: number;
}

interface CanvasRulersOverlayProps {
  camera: CanvasCameraState;
  guides: readonly ComponentCanvasGuide[];
  selectedGuideId: string | null;
  visible: boolean;
  interactionBlocked?: boolean;
  onGuidesChange: (guides: ComponentCanvasGuide[]) => void;
  onSelectGuide: (guideId: string | null) => void;
  selectedBounds?: CanvasRulerBounds | null;
  selectionActive?: boolean;
  viewport?: { width: number; height: number };
}

interface GuideDrag {
  orientation: GuideOrientation;
  guideId?: string;
  pointerId: number;
  start: { x: number; y: number };
  position: number;
  moved: boolean;
}

function worldPosition(
  orientation: GuideOrientation,
  event: CanvasPointerLike,
  rect: DOMRect,
  camera: CanvasCameraState
): number {
  return orientation === 'horizontal'
    ? (event.clientY - rect.top - camera.y) / camera.zoom
    : (event.clientX - rect.left - camera.x) / camera.zoom;
}

function guideScreenPosition(guide: ComponentCanvasGuide, camera: CanvasCameraState): number {
  return guide.orientation === 'horizontal'
    ? camera.y + guide.position * camera.zoom
    : camera.x + guide.position * camera.zoom;
}

function guideAsCanvasGuide(guide: ComponentCanvasGuide): CanvasGuide {
  return { ...guide, kind: 'guide' };
}

function guideFromCanvasGuide(guide: CanvasGuide): ComponentCanvasGuide {
  const { kind: _kind, ...persisted } = guide;
  return {
    ...persisted,
    id: guide.id ?? `${guide.orientation}-${guide.position}`,
  };
}

export function CanvasRulersOverlay({
  camera,
  guides,
  selectedGuideId,
  visible,
  interactionBlocked = false,
  onGuidesChange,
  onSelectGuide,
  selectedBounds = null,
  selectionActive = false,
  viewport = { width: 0, height: 0 },
}: CanvasRulersOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<GuideDrag | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState<GuideDrag | null>(null);
  const rulerThickness = CANVAS_RULER_THICKNESS_PX;
  const getRootRect = useCallback(() => rootRef.current?.getBoundingClientRect() ?? null, []);

  const rulerLayout = useMemo(
    () =>
      createCanvasRulerLayout({
        camera,
        viewport,
        rulerThickness,
        selectedBounds,
      }),
    [camera, rulerThickness, selectedBounds, viewport]
  );

  const cancelDrag = useCallback(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    dragRef.current = null;
    setDraft(null);
  }, []);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    []
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelDrag();
        onSelectGuide(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancelDrag, onSelectGuide]);

  const finishGuideDrag = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (interactionBlocked) {
        cancelDrag();
        return;
      }
      const rect = getRootRect();
      if (!rect) {
        cancelDrag();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (drag.moved) {
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        const overHomeRuler =
          drag.orientation === 'vertical'
            ? localX >= 0 && localX <= rulerThickness
            : localY >= 0 && localY <= rulerThickness;
        const outsideCanvas =
          drag.orientation === 'vertical'
            ? localX < 0 || localX > rect.width
            : localY < 0 || localY > rect.height;
        if (overHomeRuler || outsideCanvas) {
          if (drag.guideId) {
            const next = deleteCanvasGuide(guides.map(guideAsCanvasGuide), drag.guideId).map(
              guideFromCanvasGuide
            );
            if (next.length !== guides.length) onGuidesChange(next);
          }
          onSelectGuide(null);
        } else if (drag.guideId) {
          onGuidesChange(
            moveCanvasGuide(guides.map(guideAsCanvasGuide), drag.guideId, drag.position).map(
              guideFromCanvasGuide
            )
          );
        } else {
          const created = createCanvasGuide(guides.map(guideAsCanvasGuide), {
            orientation: drag.orientation,
            position: drag.position,
          });
          const nextGuides = created.map(guideFromCanvasGuide);
          const createdGuide = nextGuides[nextGuides.length - 1];
          onGuidesChange(nextGuides);
          onSelectGuide(createdGuide?.id ?? null);
        }
      }
      cancelDrag();
    },
    [
      cancelDrag,
      getRootRect,
      guides,
      interactionBlocked,
      onGuidesChange,
      onSelectGuide,
      rulerThickness,
    ]
  );

  const beginGuideDrag = useCallback(
    (event: ReactPointerEvent, orientation: GuideOrientation, guide?: ComponentCanvasGuide) => {
      if (event.button !== undefined && event.button !== 0 && event.button !== -1) return;
      const rect = getRootRect();
      if (interactionBlocked || !rect) return;
      event.preventDefault();
      event.stopPropagation();
      if (guide && event.currentTarget instanceof HTMLElement) {
        event.currentTarget.focus({ preventScroll: true });
      }
      const position = guide?.position ?? worldPosition(orientation, event, rect, camera);
      const drag: GuideDrag = {
        orientation,
        guideId: guide?.id,
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        position,
        moved: false,
      };
      if (guide?.locked) {
        onSelectGuide(guide.id);
        return;
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable in a few embedded browser surfaces.
      }
      onSelectGuide(guide?.id ?? null);
      dragRef.current = drag;
      setDraft(drag);

      const root = rootRef.current;
      const win = root?.ownerDocument.defaultView ?? window;
      const captureTarget = event.currentTarget as HTMLElement;
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== drag.pointerId) return;
        const current = dragRef.current;
        const moveRect = getRootRect();
        if (interactionBlocked || !current || !moveRect) return;
        moveEvent.preventDefault();
        moveEvent.stopPropagation();
        const distance = Math.hypot(
          moveEvent.clientX - current.start.x,
          moveEvent.clientY - current.start.y
        );
        const next = {
          ...current,
          moved: current.moved || distance >= CANVAS_DRAG_THRESHOLD_PX,
          position: worldPosition(current.orientation, moveEvent, moveRect, camera),
        };
        dragRef.current = next;
        setDraft(next);
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== drag.pointerId) return;
        finishGuideDrag(upEvent);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== drag.pointerId) return;
        cancelDrag();
      };
      const cleanup = () => {
        win.removeEventListener('pointermove', onMove);
        win.removeEventListener('pointerup', onUp);
        win.removeEventListener('pointercancel', onCancel);
        try {
          if (captureTarget.hasPointerCapture?.(drag.pointerId)) {
            captureTarget.releasePointerCapture?.(drag.pointerId);
          }
        } catch {
          // The pointer may already have been released by the browser.
        }
        if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
      };
      dragCleanupRef.current = cleanup;
      win.addEventListener('pointermove', onMove);
      win.addEventListener('pointerup', onUp);
      win.addEventListener('pointercancel', onCancel);
    },
    [camera, cancelDrag, finishGuideDrag, getRootRect, interactionBlocked, onSelectGuide]
  );

  const deleteGuide = useCallback(
    (guide: ComponentCanvasGuide) => {
      if (interactionBlocked) return;
      const next = deleteCanvasGuide(guides.map(guideAsCanvasGuide), guide.id).map(
        guideFromCanvasGuide
      );
      if (next.length !== guides.length) onGuidesChange(next);
      onSelectGuide(next.some((candidate) => candidate.id === guide.id) ? guide.id : null);
    },
    [guides, interactionBlocked, onGuidesChange, onSelectGuide]
  );

  const renderedGuides = useMemo(() => {
    if (!draft?.moved) return guides;
    if (draft.guideId) {
      return guides.map((guide) =>
        guide.id === draft.guideId ? { ...guide, position: draft.position } : guide
      );
    }
    return [
      ...guides,
      {
        id: 'canvas-guide-draft',
        orientation: draft.orientation,
        position: draft.position,
      },
    ];
  }, [draft, guides]);

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      className="component-canvas-rulers"
      data-blocked={interactionBlocked ? 'true' : undefined}
      data-testid="component-canvas-rulers"
      data-selection-active={selectionActive ? 'true' : undefined}
      onPointerCancel={cancelDrag}
      aria-label="Canvas rulers and guides"
      aria-disabled={interactionBlocked || undefined}
    >
      <div
        className="component-canvas-ruler component-canvas-ruler--horizontal"
        aria-hidden="true"
        data-testid="component-canvas-ruler-surface-horizontal"
      />
      <button
        type="button"
        className="component-canvas-ruler-hit-area component-canvas-ruler-hit-area--horizontal"
        aria-label="Create horizontal guide"
        onPointerDown={(event) => beginGuideDrag(event, 'horizontal')}
      />
      <div
        className="component-canvas-ruler component-canvas-ruler--vertical"
        aria-hidden="true"
        data-testid="component-canvas-ruler-surface-vertical"
      />
      <button
        type="button"
        className="component-canvas-ruler-hit-area component-canvas-ruler-hit-area--vertical"
        aria-label="Create vertical guide"
        onPointerDown={(event) => beginGuideDrag(event, 'vertical')}
      />
      <RulerTicks axis={rulerLayout.horizontal} />
      <RulerTicks axis={rulerLayout.vertical} />
      {renderedGuides.map((guide) => {
        const position = guideScreenPosition(guide, camera);
        const selected =
          guide.id === selectedGuideId ||
          (guide.id === 'canvas-guide-draft' && draft?.moved === true && !draft.guideId);
        const locked = guide.locked === true;
        return (
          <button
            key={guide.id}
            type="button"
            className={`component-canvas-user-guide component-canvas-user-guide--${guide.orientation}${selected ? ' is-selected' : ''}${locked ? ' is-locked' : ''}`}
            style={guide.orientation === 'horizontal' ? { top: position } : { left: position }}
            data-canvas-guide-id={guide.id}
            aria-label={`${locked ? 'Locked ' : ''}${guide.orientation} guide at ${Math.round(guide.position)}`}
            aria-pressed={selected}
            aria-keyshortcuts="Delete Backspace"
            title="Drag to move; press Delete or Backspace to remove"
            onFocus={() => onSelectGuide(guide.id)}
            onClick={() => onSelectGuide(guide.id)}
            onPointerDown={(event) => beginGuideDrag(event, guide.orientation, guide)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelDrag();
                onSelectGuide(null);
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                event.stopPropagation();
                deleteGuide(guide);
              }
            }}
          />
        );
      })}
      <span className="component-canvas-ruler-corner" aria-hidden="true" />
    </div>
  );
}

function RulerTicks({ axis }: { axis: CanvasRulerAxis }) {
  return (
    <>
      {axis.selectionBand ? (
        <>
          <span
            className={`component-canvas-ruler-selection component-canvas-ruler-selection--${axis.orientation}`}
            style={
              axis.orientation === 'horizontal'
                ? {
                    left: axis.selectionBand.start,
                    width: axis.selectionBand.end - axis.selectionBand.start,
                  }
                : {
                    top: axis.selectionBand.start,
                    height: axis.selectionBand.end - axis.selectionBand.start,
                  }
            }
            aria-hidden="true"
          />
          {(['start', 'end'] as const).map((edge) => {
            const offset = axis.selectionBand?.[edge] ?? 0;
            const label = axis.selectionBand?.[`${edge}Label`] ?? '';
            return (
              <span
                key={`${axis.orientation}-${edge}`}
                className={`component-canvas-ruler-boundary component-canvas-ruler-boundary--${axis.orientation} is-${edge}`}
                style={
                  axis.orientation === 'horizontal'
                    ? { left: offset, opacity: canvasRulerMarkerOpacity(offset) }
                    : { top: offset, opacity: canvasRulerMarkerOpacity(offset) }
                }
                data-testid={`component-canvas-ruler-boundary-${axis.orientation}-${edge}`}
                aria-hidden="true"
              >
                <span className="component-canvas-ruler-boundary__label">{label}</span>
              </span>
            );
          })}
        </>
      ) : null}
      {axis.ticks.map((tick) => (
        <span
          key={`${axis.orientation}-${tick.value}`}
          className={`component-canvas-ruler-tick component-canvas-ruler-tick--${axis.orientation}${tick.major ? ' is-major' : ''}${tick.selected ? ' is-selected' : ''}`}
          style={
            axis.orientation === 'horizontal'
              ? { left: tick.offset, opacity: canvasRulerMarkerOpacity(tick.offset) }
              : { top: tick.offset, opacity: canvasRulerMarkerOpacity(tick.offset) }
          }
          aria-hidden="true"
        >
          {tick.label ? <span className="component-canvas-ruler-label">{tick.label}</span> : null}
        </span>
      ))}
    </>
  );
}
