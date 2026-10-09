/**
 * Standalone browser surface for looking at the production ColorPicker without
 * starting the workspace, preview proxy, or terminal. This file is served only
 * by `vite.harness.config.ts`; the production Vite entry remains `index.html`.
 */

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { ColorPicker } from '../components/edit/ColorPicker';
import { DockablePanel } from '../components/primitives/DockablePanel';
import { TooltipProvider } from '../components/primitives/Tooltip';
import {
  COLOR_PICKER_HEIGHT,
  COLOR_PICKER_POSITION_KEY,
  COLOR_PICKER_SIZE_KEY,
  COLOR_PICKER_WIDTH,
} from '../lib/color';
import '../styles/index.css';
import './freeze.css';

const projectPath = '/Users/harness/ShipStudio/color-picker-fixture';
const initialColor = '#777777';
const recentKey = `shipstudio.color-picker.recent.v1:${encodeURIComponent(projectPath)}`;

const variables = [
  { name: '--brand-violet', value: '#815ac0' },
  { name: '--brand-teal', value: '#167d8d' },
  { name: '--surface-canvas', value: '#ffffff' },
  { name: '--unresolved-token' },
] as const;

// ColorPicker uses one native capability check. The browser harness replaces
// only that IPC boundary; all picker controls, theme tokens, and providers are real.
mockWindows('main');
mockIPC((command) => {
  if (command === 'get_color_sampler_support') {
    return {
      available: false,
      reason: 'Screen color sampling is unavailable in this browser fixture.',
    };
  }
  throw new Error(`[color-picker harness] Unexpected Tauri command: ${command}`);
});

document.title = 'Ship Studio color picker harness';
document.documentElement.setAttribute('data-harness-freeze', '');

function ColorPickerHarness() {
  const [value, setValue] = useState(initialColor);
  const [pickerHeight, setPickerHeight] = useState(COLOR_PICKER_HEIGHT);

  return (
    <div data-color-picker-fixture data-authored-value={value} data-project-path={projectPath}>
      <DockablePanel
        docked={false}
        ariaLabel="Color picker"
        positionKey={COLOR_PICKER_POSITION_KEY}
        sizeKey={COLOR_PICKER_SIZE_KEY}
        floatingSize={{ width: COLOR_PICKER_WIDTH, height: pickerHeight }}
        initialPosition={() => ({
          left: Math.max(8, Math.round((window.innerWidth - COLOR_PICKER_WIDTH) / 2)),
          top: Math.max(8, Math.round((window.innerHeight - pickerHeight) / 2)),
        })}
        resizable={false}
        keepWithinViewport
        surfaceClassName="ss-color-picker__floating-surface"
      >
        <div className="ss-color-picker__floating-content">
          <ColorPicker
            value={value}
            authoredValue={value}
            onChange={setValue}
            onClose={() => undefined}
            contrastContext={{ backgroundColor: '#ffffff', category: 'normal-text' }}
            variables={variables}
            projectPath={projectPath}
            onHeightChange={setPickerHeight}
          />
        </div>
      </DockablePanel>
    </div>
  );
}

// Seed a small, realistic project history before the component reads storage.
window.localStorage.setItem(recentKey, JSON.stringify(['#6e4b87', '#167d8d']));

const root = createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());

root.render(
  <StrictMode>
    <TooltipProvider>
      <ColorPickerHarness />
    </TooltipProvider>
  </StrictMode>
);
