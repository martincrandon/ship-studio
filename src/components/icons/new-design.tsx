import type { SVGAttributes } from 'react';
import active from './assets/new-design/Active.svg?raw';
import alert from './assets/new-design/alert.svg?raw';
import ai from './assets/new-design/AI.svg?raw';
import alignCenter from './assets/new-design/align-center.svg?raw';
import alignItemsCenter from './assets/new-design/align-items-center.svg?raw';
import alignItemsEnd from './assets/new-design/align-items-end.svg?raw';
import alignItemsStart from './assets/new-design/align-items-start.svg?raw';
import alignItemsStretch from './assets/new-design/align-items-stretch.svg?raw';
import alignLeft from './assets/new-design/align-left.svg?raw';
import alignRight from './assets/new-design/align-right.svg?raw';
import breakpointFull from './assets/new-design/breakpoint-full.svg?raw';
import cancel from './assets/new-design/Cancel.svg?raw';
import chevronDown from './assets/new-design/Chevron Down.svg?raw';
import chevronRight from './assets/new-design/Chevron Right.svg?raw';
import closedEye from './assets/new-design/Closed Eye.svg?raw';
import codeBlock from './assets/new-design/Code Block.svg?raw';
import contract from './assets/new-design/Contract.svg?raw';
import copy from './assets/new-design/Copy.svg?raw';
import desktop from './assets/new-design/Desktop.svg?raw';
import down from './assets/new-design/Down.svg?raw';
import duplicate from './assets/new-design/Duplicate.svg?raw';
import decorationNone from './assets/new-design/decoration-none.svg?raw';
import decorationOverline from './assets/new-design/decoration-overline.svg?raw';
import decorationStrike from './assets/new-design/decoration-strike.svg?raw';
import decorationUnderline from './assets/new-design/decoration-underline.svg?raw';
import displayBlock from './assets/new-design/display-block.svg?raw';
import displayFlex from './assets/new-design/display-flex.svg?raw';
import displayGrid from './assets/new-design/display-grid.svg?raw';
import displayInlineBlock from './assets/new-design/display-inline-block.svg?raw';
import displayInlineFlex from './assets/new-design/display-inline-flex.svg?raw';
import expand from './assets/new-design/Expand.svg?raw';
import external from './assets/new-design/External.svg?raw';
import eye from './assets/new-design/Eye.svg?raw';
import file from './assets/new-design/file.svg?raw';
import fileText from './assets/new-design/file-text.svg?raw';
import folder from './assets/new-design/folder.svg?raw';
import folderOpen from './assets/new-design/folder-open.svg?raw';
import home from './assets/new-design/Home.svg?raw';
import image from './assets/new-design/Image.svg?raw';
import italicsOff from './assets/new-design/ItalicsOff.svg?raw';
import italicsOn from './assets/new-design/ItalicsOn.svg?raw';
import justifyBetween from './assets/new-design/justify-between.svg?raw';
import justifyCenter from './assets/new-design/justify-center.svg?raw';
import justifyEnd from './assets/new-design/justify-end.svg?raw';
import justifyStart from './assets/new-design/justify-start.svg?raw';
import left from './assets/new-design/Left.svg?raw';
import list from './assets/new-design/list.svg?raw';
import mobile from './assets/new-design/Mobile.svg?raw';
import mobileHorizontal from './assets/new-design/Mobile Horizontal.svg?raw';
import moveToWorkspace from './assets/new-design/move-to-workspace.svg?raw';
import newWorkspace from './assets/new-design/new-workspace.svg?raw';
import newFolder from './assets/new-design/new-folder.svg?raw';
import overflowScroll from './assets/new-design/overflow-scroll.svg?raw';
import pin from './assets/new-design/pin.svg?raw';
import plugin from './assets/new-design/Plugin.svg?raw';
import plus from './assets/new-design/Plus.svg?raw';
import redo from './assets/new-design/Redo.svg?raw';
import reload from './assets/new-design/Reload.svg?raw';
import right from './assets/new-design/Right.svg?raw';
import screenshot from './assets/new-design/Screenshot.svg?raw';
import screenshotCrop from './assets/new-design/Screenshot Crop 2.svg?raw';
import search from './assets/new-design/Search.svg?raw';
import save from './assets/new-design/save.svg?raw';
import settings from './assets/new-design/Settings.svg?raw';
import sharedLibrary from './assets/new-design/shared-library.svg?raw';
import sidebar from './assets/new-design/sidebar.svg?raw';
import slack from './assets/new-design/Slack.svg?raw';
import switchWorkspace from './assets/new-design/switch-workspace.svg?raw';
import tablet from './assets/new-design/Tablet.svg?raw';
import tick from './assets/new-design/tick.svg?raw';
import trash from './assets/new-design/Trash.svg?raw';
import undo from './assets/new-design/Undo.svg?raw';
import up from './assets/new-design/Up.svg?raw';
import editMode from './assets/new-design/edit-mode.svg?raw';
import gitBranch from './assets/new-design/git-branch.svg?raw';
import grid from './assets/new-design/grid.svg?raw';
import warningAlert from './assets/new-design/warning-alert.svg?raw';
import wrapDown from './assets/new-design/wrap-down.svg?raw';
import { getIconData, ICON_STROKE_WIDTH, resolveIconSize } from './provenance';

const sources = {
  Active: active,
  Alert: alert,
  AI: ai,
  AlignCenter: alignCenter,
  AlignItemsCenter: alignItemsCenter,
  AlignItemsEnd: alignItemsEnd,
  AlignItemsStart: alignItemsStart,
  AlignItemsStretch: alignItemsStretch,
  AlignLeft: alignLeft,
  AlignRight: alignRight,
  BreakpointFull: breakpointFull,
  Cancel: cancel,
  ChevronDown: chevronDown,
  ChevronRight: chevronRight,
  ClosedEye: closedEye,
  CodeBlock: codeBlock,
  Contract: contract,
  Copy: copy,
  Desktop: desktop,
  Down: down,
  Duplicate: duplicate,
  DecorationNone: decorationNone,
  DecorationOverline: decorationOverline,
  DecorationStrike: decorationStrike,
  DecorationUnderline: decorationUnderline,
  DisplayBlock: displayBlock,
  DisplayFlex: displayFlex,
  DisplayGrid: displayGrid,
  DisplayInlineBlock: displayInlineBlock,
  DisplayInlineFlex: displayInlineFlex,
  EditMode: editMode,
  Expand: expand,
  External: external,
  Eye: eye,
  File: file,
  FileText: fileText,
  Folder: folder,
  FolderOpen: folderOpen,
  GitBranch: gitBranch,
  Grid: grid,
  Home: home,
  Image: image,
  ItalicsOff: italicsOff,
  ItalicsOn: italicsOn,
  JustifyBetween: justifyBetween,
  JustifyCenter: justifyCenter,
  JustifyEnd: justifyEnd,
  JustifyStart: justifyStart,
  Left: left,
  List: list,
  Mobile: mobile,
  MobileHorizontal: mobileHorizontal,
  MoveToWorkspace: moveToWorkspace,
  NewWorkspace: newWorkspace,
  NewFolder: newFolder,
  OverflowScroll: overflowScroll,
  Pin: pin,
  Plugin: plugin,
  Plus: plus,
  Redo: redo,
  Reload: reload,
  Right: right,
  Screenshot: screenshot,
  ScreenshotCrop: screenshotCrop,
  Search: search,
  Save: save,
  Settings: settings,
  SharedLibrary: sharedLibrary,
  Sidebar: sidebar,
  Slack: slack,
  SwitchWorkspace: switchWorkspace,
  Tablet: tablet,
  Tick: tick,
  Trash: trash,
  Undo: undo,
  Up: up,
  WarningAlert: warningAlert,
  WrapDown: wrapDown,
} as const;

export type NewDesignSource = keyof typeof sources;

interface NewDesignIconProps extends SVGAttributes<SVGSVGElement> {
  iconName: string;
  source: NewDesignSource;
  compact?: boolean;
  size?: number;
}

function svgBody(source: string): string {
  return source
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/#979797/g, 'currentColor');
}

const bodies = Object.fromEntries(
  Object.entries(sources).map(([name, source]) => [name, svgBody(source)])
) as Record<NewDesignSource, string>;

export function NewDesignIcon({
  iconName,
  source,
  compact = false,
  size = 24,
  ...svgProps
}: NewDesignIconProps) {
  const renderedSize = resolveIconSize(size, compact);

  return (
    <svg
      {...getIconData(iconName)}
      {...svgProps}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={ICON_STROKE_WIDTH}
      dangerouslySetInnerHTML={{ __html: bodies[source] }}
    />
  );
}
