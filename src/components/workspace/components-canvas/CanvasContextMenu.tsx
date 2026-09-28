import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '../../primitives/ContextMenu';

export function CanvasContextMenu({
  hasSelection,
  hasGuideSelection,
  onDuplicate,
  onDelete,
  onDeleteGuide,
  onBringForward,
  onSendBackward,
  onFitSelection,
}: {
  hasSelection: boolean;
  hasGuideSelection: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  onDeleteGuide: () => void;
  onBringForward: () => void;
  onSendBackward: () => void;
  onFitSelection: () => void;
}) {
  return (
    <ContextMenuContent
      className="component-canvas-context-menu"
      aria-label="Canvas selection actions"
    >
      <ContextMenuLabel>Canvas selection</ContextMenuLabel>
      <ContextMenuItem disabled={!hasSelection} onSelect={onDuplicate}>
        Duplicate
        <ContextMenuShortcut>⌘D</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!hasSelection && !hasGuideSelection}
        onSelect={hasGuideSelection ? onDeleteGuide : onDelete}
        variant="destructive"
      >
        Delete
        <ContextMenuShortcut>⌫</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!hasSelection} onSelect={onBringForward}>
        Bring forward
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasSelection} onSelect={onSendBackward}>
        Send backward
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasSelection} onSelect={onFitSelection}>
        Fit selection
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
