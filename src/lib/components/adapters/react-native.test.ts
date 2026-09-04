import { describe, expect, it } from 'vitest';
import { buildComponentIndex, planInsertComponent } from '../index';
import { validateReactMutation } from '../mutation';
import { sha256 } from '../ranges';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from '../types';

function file(path: string, content: string): SourceFileSnapshot {
  return { file: path, content, contentHash: sha256(content) };
}

function snapshot(files: SourceFileSnapshot[]): ComponentSourceSnapshot {
  return {
    workspaceRoot: '.',
    revision: sha256(files.map((entry) => `${entry.file}:${entry.contentHash}`).join('\n')),
    files,
    partial: false,
    diagnostics: [],
  };
}

describe('React Native component adapter', () => {
  it('indexes JSX source under a separate native dialect with source-only writes', () => {
    const source = snapshot([
      file(
        'src/Button.tsx',
        'export function Button({ label }: { label: string }) { return <Text>{label}</Text>; }'
      ),
      file(
        'src/App.tsx',
        'import { Button } from \'./Button\'; export default function App() { return <View><Button label="Launch" /></View>; }'
      ),
    ]);

    const index = buildComponentIndex(source, { projectType: 'reactnative' });
    const button = index.components.find((component) => component.name === 'Button');
    const instance = index.instances.find((candidate) => candidate.componentId === button?.id);

    expect(index.profile.dialects).toEqual(['react-native']);
    expect(button).toMatchObject({
      id: 'react-native:src/Button.tsx#Button',
      dialect: 'react-native',
      capabilities: {
        catalog: true,
        usageGraph: true,
        place: true,
        editStaticProps: true,
        componentTreeBoundary: false,
      },
    });
    expect(instance?.props.label).toMatchObject({
      kind: 'static',
      value: { kind: 'string', value: 'Launch' },
    });
    const insertion = planInsertComponent(
      {
        kind: 'insert',
        componentId: button!.id,
        anchor: {
          file: 'src/App.tsx',
          line: 1,
          html: '<Button label="Launch" />',
          position: 'after',
        },
        props: { label: { kind: 'string', value: 'Secondary' } },
      },
      index,
      source
    );
    expect(insertion).toMatchObject({
      status: 'planned',
      plan: {
        dialect: 'react-native',
        parserToken: 'react-native-component-plan-v1',
      },
    });
    if (insertion.status === 'planned') {
      expect(
        validateReactMutation({ plan: insertion.plan, snapshot: source }, 'react-native')
      ).toEqual({
        status: 'valid',
        diagnostics: [],
      });
    }
  });
});
