// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { useDragAndDrop } from './useDragAndDrop';
let root: Root;
let drag: ReturnType<typeof useDragAndDrop>;
afterEach(async () => { if (root) await act(async () => root.unmount()); });
async function mount() {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const external = vi.fn(async () => {});
  const crossPanel = vi.fn(async () => {});
  function Probe() {
    drag = useDragAndDrop({
      notify: { success: () => null, error: () => null },
      humanLog: { logStart: () => 'id', logSuccess: () => 'id', logError: () => 'id' },
      currentRemotePath: '/remote', currentLocalPath: 'C:/local', stopCount: { current: 7 },
      loadRemoteFiles: async () => {}, loadLocalFiles: async () => {},
      onExternalFileDrop: external, onCrossPanelDrop: crossPanel,
    });
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  return { external, crossPanel };
}
function event(files: File[]) {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { files, types: ['Files'], dropEffect: '' } } as unknown as React.DragEvent;
}
it('uploads an Explorer file onto the remote background without requiring local panel selection', async () => {
  const { external, crossPanel } = await mount();
  const files = [new File(['new'], 'report.bin')];
  const e = event(files);
  await act(async () => drag.handlePanelDragOver(e, 'remote'));
  expect(e.dataTransfer.dropEffect).toBe('copy');
  await act(async () => drag.handlePanelDrop(e, 'remote'));
  expect(external).toHaveBeenCalledExactlyOnceWith(files, '/remote', 7);
  expect(crossPanel).not.toHaveBeenCalled();
});
it('uses the folder row under the drop, and consumes the event once', async () => {
  const { external } = await mount();
  const files = [new File(['new'], 'report.bin')];
  const e = event(files);
  await act(async () => drag.handleDragOver(e, '/remote/subfolder', true, 'remote'));
  expect(drag.dropTargetPath).toBe('/remote/subfolder');
  await act(async () => drag.handleDrop(e, '/remote/subfolder', 'remote'));
  expect(external).toHaveBeenCalledExactlyOnceWith(files, '/remote/subfolder', 7);
  expect(e.stopPropagation).toHaveBeenCalled();
});
it('never turns a drop on the local panel into a remote upload', async () => {
  const { external } = await mount();
  await act(async () => drag.handlePanelDrop(event([new File([], 'local')]), 'local'));
  expect(external).not.toHaveBeenCalled();
});
