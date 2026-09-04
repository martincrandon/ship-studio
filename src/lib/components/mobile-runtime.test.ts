import { describe, expect, it, vi } from 'vitest';
import { buildComponentIndex } from './index';
import { buildFlutterComponentIndex } from './flutter-analyzer';
import {
  createMobileRuntimeBridge,
  createMobileRuntimeEmitter,
  parseMobileRuntimeMessage,
  type MobileRuntimeBinding,
  type MobileRuntimeMessage,
} from './mobile-runtime';
import { sha256 } from './ranges';
import type { ComponentSourceSnapshot, SourceRef } from './types';

function sourceFile(file: string, content: string) {
  return { file, content, contentHash: sha256(content) };
}

function snapshot(files: ReturnType<typeof sourceFile>[], workspaceRoot = '.') {
  return {
    workspaceRoot,
    revision: sha256(files.map((file) => `${file.file}:${file.contentHash}`).join('\n')),
    files,
    partial: false,
    diagnostics: [],
  } satisfies ComponentSourceSnapshot;
}

function rnFixture() {
  const source = snapshot([
    sourceFile('src/Button.tsx', 'export function Button() { return <View testID="button" />; }'),
    sourceFile(
      'src/App.tsx',
      'import { Button } from "./Button"; export default function App() { return <Button />; }'
    ),
  ]);
  const index = buildComponentIndex(source, { projectType: 'reactnative' });
  const component = index.components.find((candidate) => candidate.name === 'Button')!;
  const instance = index.instances.find((candidate) => candidate.componentId === component.id)!;
  return { index, component, instance };
}

function flutterAnchor(file: string, content: string, start: number, end: number): SourceRef {
  return {
    file,
    start,
    end,
    line: 1,
    column: start + 1,
    contentHash: sha256(content),
  };
}

describe('mobile component runtime bridge', () => {
  it('accepts an explicit React Native hello and exact source-bound instance', () => {
    const { index, component, instance } = rnFixture();
    const received: Array<MobileRuntimeBinding | null> = [];
    const bridge = createMobileRuntimeBridge({
      index,
      projectPath: '/workspace/project',
      renderer: 'react-native',
      sessionToken: 'token-1',
      onBinding: (binding) => received.push(binding),
    });
    const messages: MobileRuntimeMessage[] = [];
    const emitter = createMobileRuntimeEmitter({
      renderer: 'react-native',
      bridgeSession: 'bridge-1',
      sessionToken: 'token-1',
      runtimeVersion: 'hermes-dev',
      frameworkVersion: '0.83.0',
      send: (message) => messages.push(message),
    });

    emitter.hello();
    emitter.boundary('native-fiber-1', component.definition, instance.invocation, 'home');
    expect(bridge.receive(messages[0])).toMatchObject({ status: 'cleared' });
    expect(bridge.receive(messages[1])).toMatchObject({
      status: 'accepted',
      binding: {
        confidence: 'exact',
        componentId: component.id,
        instanceId: instance.id,
        runtimeId: 'native-fiber-1',
        routeKey: 'home',
      },
    });
    expect(received[received.length - 1]).toMatchObject({
      componentId: component.id,
      instanceId: instance.id,
    });
  });

  it('keeps definition-only runtime data source-anchored and never projects a DOM boundary', () => {
    const { index, component } = rnFixture();
    const bridge = createMobileRuntimeBridge({
      index,
      projectPath: '/workspace/project',
      renderer: 'react-native',
      sessionToken: 'token',
    });
    expect(
      bridge.receive({
        protocol: 1,
        type: 'hello',
        renderer: 'react-native',
        bridgeSession: 'session',
        sessionToken: 'token',
        runtimeVersion: 'hermes-dev',
        frameworkVersion: null,
        capabilities: ['source-binding'],
      })
    ).toMatchObject({ status: 'cleared' });
    const result = bridge.receive({
      protocol: 1,
      type: 'boundary',
      renderer: 'react-native',
      bridgeSession: 'session',
      sessionToken: 'token',
      runtimeId: 'native-fiber-2',
      definition: component.definition,
      invocation: null,
      routeKey: null,
    });
    expect(result).toMatchObject({
      status: 'accepted',
      binding: { confidence: 'sourceAnchored', componentId: component.id },
    });
    expect(index.profile.capabilities['react-native'].componentTreeBoundary).toBe(false);
  });

  it('refuses unauthenticated, stale, unsafe, and ambiguous runtime data', () => {
    const { index, component, instance } = rnFixture();
    const bridge = createMobileRuntimeBridge({
      index,
      projectPath: '/workspace/project',
      renderer: 'react-native',
      sessionToken: 'token',
    });
    const boundary = {
      protocol: 1,
      type: 'boundary' as const,
      renderer: 'react-native' as const,
      bridgeSession: 'session',
      sessionToken: 'token',
      runtimeId: 'id',
      definition: component.definition,
      invocation: instance.invocation,
      routeKey: null,
    };
    expect(bridge.receive(boundary)).toMatchObject({ status: 'refused', code: 'unauthenticated' });
    expect(
      bridge.receive({
        ...boundary,
        definition: { ...component.definition, contentHash: 'a'.repeat(64) },
      })
    ).toMatchObject({ status: 'refused', code: 'unauthenticated' });
    expect(
      parseMobileRuntimeMessage({
        ...boundary,
        definition: { ...component.definition, file: '../outside.tsx' },
      })
    ).toMatchObject({ status: 'valid' });
    bridge.receive({
      protocol: 1,
      type: 'hello',
      renderer: 'react-native',
      bridgeSession: 'session',
      sessionToken: 'token',
      runtimeVersion: 'hermes-dev',
      frameworkVersion: null,
      capabilities: ['source-binding'],
    });
    expect(
      bridge.receive({
        ...boundary,
        definition: { ...component.definition, contentHash: 'a'.repeat(64) },
      })
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
    expect(
      bridge.receive({
        ...boundary,
        definition: { ...component.definition, file: '../outside.tsx' },
      })
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
    const duplicateIndex = {
      ...index,
      instances: [instance, { ...instance, id: `${instance.id}-duplicate` }],
    };
    const duplicateBridge = createMobileRuntimeBridge({
      index: duplicateIndex,
      projectPath: '/workspace/project',
      renderer: 'react-native',
      sessionToken: 'token',
    });
    duplicateBridge.receive({
      protocol: 1,
      type: 'hello',
      renderer: 'react-native',
      bridgeSession: 'session',
      sessionToken: 'token',
      runtimeVersion: 'hermes-dev',
      frameworkVersion: null,
      capabilities: ['source-binding'],
    });
    expect(duplicateBridge.receive(boundary)).toMatchObject({
      status: 'refused',
      code: 'ambiguous-instance',
    });
  });

  it('validates a Flutter analyzer source record before accepting Widget Inspector provenance', () => {
    const content =
      'import "package:flutter/widgets.dart"; class CardWidget extends StatelessWidget {}';
    const definition = flutterAnchor(
      'lib/card.dart',
      content,
      content.indexOf('class'),
      content.length
    );
    const invocationContent = 'Widget build() => CardWidget();';
    const invocation = flutterAnchor(
      'lib/home.dart',
      invocationContent,
      18,
      invocationContent.length - 1
    );
    const source = snapshot([
      sourceFile('lib/card.dart', content),
      sourceFile('lib/home.dart', invocationContent),
    ]);
    const index = buildFlutterComponentIndex(source, {
      protocol: 1,
      analyzerVersion: '3.11.0',
      workspaceRoot: '.',
      partial: false,
      diagnostics: [],
      components: [
        {
          name: 'CardWidget',
          localName: 'CardWidget',
          exportName: 'CardWidget',
          kind: 'widget',
          definition,
          props: [],
          slots: [],
          diagnostics: [],
        },
      ],
      instances: [{ definition, invocation, route: '/', props: {}, slots: [] }],
    });
    const bridge = createMobileRuntimeBridge({
      index,
      projectPath: '/workspace/project',
      renderer: 'flutter',
      sessionToken: 'flutter-token',
    });
    bridge.receive({
      protocol: 1,
      type: 'hello',
      renderer: 'flutter',
      bridgeSession: 'flutter-session',
      sessionToken: 'flutter-token',
      runtimeVersion: 'vm-service',
      frameworkVersion: '3.32.0',
      capabilities: ['source-binding'],
    });
    expect(
      bridge.receive({
        protocol: 1,
        type: 'boundary',
        renderer: 'flutter',
        bridgeSession: 'flutter-session',
        sessionToken: 'flutter-token',
        runtimeId: 'inspector-ref-1',
        definition,
        invocation,
        routeKey: '/',
      })
    ).toMatchObject({
      status: 'accepted',
      binding: { confidence: 'exact', componentId: 'flutter:lib/card.dart#CardWidget' },
    });

    expect(
      buildFlutterComponentIndex(source, {
        protocol: 1,
        analyzerVersion: '4.0.0',
        workspaceRoot: '.',
        partial: false,
        diagnostics: [],
        components: [],
        instances: [],
      })
    ).toMatchObject({
      partial: true,
      components: [],
      diagnostics: [{ code: 'flutter-analyzer-version' }],
    });
  });

  it('emits cleanup on dispose and ignores messages after disposal', () => {
    const send = vi.fn<(message: MobileRuntimeMessage) => void>();
    const emitter = createMobileRuntimeEmitter({
      renderer: 'flutter',
      bridgeSession: 'session',
      sessionToken: 'token',
      runtimeVersion: 'vm-service',
      frameworkVersion: null,
      send,
    });
    emitter.dispose();
    emitter.dispose();
    emitter.hello();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'clear', reason: 'disconnect' })
    );
  });
});
