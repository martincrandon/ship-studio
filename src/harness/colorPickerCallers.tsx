/**
 * Exercises the production ColorField and EditPopover entry points with their
 * real DockablePanel and ColorPicker children in the browser harness.
 */

import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { ColorField } from '../components/edit/ColorControls';
import { EditPopover } from '../components/edit/EditPopover';
import { Button } from '../components/primitives/Button';
import { TooltipProvider } from '../components/primitives/Tooltip';
import { BASE_BREAKPOINT, DEFAULT_BREAKPOINTS, type LayerContext } from '../lib/edit';
import type { ValueFieldVariable } from '../components/primitives/ValueField';
import type { ColorContrastContext } from '../lib/colorContrast';
import '../styles/index.css';
import './freeze.css';

const projectPath = '/Users/harness/ShipStudio/color-picker-callers';
const initialColor = '#777777';
const recentKey = `shipstudio.color-picker.recent.v1:${encodeURIComponent(projectPath)}`;
const harnessQuery = new URLSearchParams(window.location.search);
const variables: ValueFieldVariable[] = [
  { name: '--brand-violet', value: '#815ac0' },
  { name: '--brand-teal', value: '#167d8d' },
  { name: '--surface-canvas', value: '#ffffff' },
  { name: '--unresolved-token' },
];
const layer: LayerContext = {
  bp: BASE_BREAKPOINT,
  ordered: DEFAULT_BREAKPOINTS,
  known: new Set(),
};
const contrastContext: ColorContrastContext = {
  backgroundColor: harnessQuery.get('contrast-backdrop') === 'medium' ? '#777777' : '#ffffff',
  category: harnessQuery.get('contrast-category') === 'large-text' ? 'large-text' : 'normal-text',
};

mockWindows('main');
mockIPC((command) => {
  if (command === 'get_color_sampler_support') {
    return {
      available: false,
      reason: 'Screen color sampling is unavailable in this browser fixture.',
    };
  }
  throw new Error(`[color-picker caller harness] Unexpected Tauri command: ${command}`);
});

document.title = 'Ship Studio color picker caller harness';
document.documentElement.setAttribute('data-harness-freeze', '');
window.localStorage.setItem(recentKey, JSON.stringify(['#6e4b87', '#167d8d']));

function ColorPickerCallerHarness() {
  const [caller, setCaller] = useState<'color-field' | 'edit-popover'>('color-field');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const setAnchorRef = useCallback((node: HTMLButtonElement | null) => setAnchor(node), []);

  return (
    <main data-color-picker-caller-fixture data-active-caller={caller}>
      <nav aria-label="Color picker caller fixtures">
        <Button
          size="compact"
          variant="default"
          aria-pressed={caller === 'color-field'}
          onClick={() => {
            setCaller('color-field');
            setPopoverOpen(false);
          }}
        >
          ColorField
        </Button>
        <Button
          size="compact"
          variant="default"
          aria-pressed={caller === 'edit-popover'}
          onClick={() => {
            setCaller('edit-popover');
            setPopoverOpen(false);
          }}
        >
          EditPopover
        </Button>
      </nav>

      {caller === 'color-field' ? (
        <section aria-label="ColorField caller">
          <ColorField
            label="Text color"
            css="color"
            prefix="text"
            currentClass="text-[#777777]"
            layer={layer}
            computed={{ color: 'rgb(119, 119, 119)', 'background-color': 'rgb(255, 255, 255)' }}
            variables={variables}
            projectPath={projectPath}
            contrastContext={contrastContext}
            onApplyEnum={() => undefined}
            onReset={() => undefined}
          />
        </section>
      ) : (
        <section aria-label="EditPopover caller">
          <Button
            ref={setAnchorRef}
            size="default"
            variant="default"
            onClick={() => setPopoverOpen((open) => !open)}
          >
            Open color value editor
          </Button>
          {popoverOpen && anchor && (
            <EditPopover
              anchor={anchor}
              initial={initialColor}
              variables={variables}
              projectPath={projectPath}
              contrastContext={contrastContext}
              onCommit={() => undefined}
              onClose={() => setPopoverOpen(false)}
            />
          )}
        </section>
      )}
    </main>
  );
}

const root = createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());

root.render(
  <StrictMode>
    <TooltipProvider>
      <ColorPickerCallerHarness />
    </TooltipProvider>
  </StrictMode>
);
