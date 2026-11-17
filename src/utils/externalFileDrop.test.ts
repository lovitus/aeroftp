// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
const events = vi.hoisted(() => ({ handler: null as null | ((event: { payload: unknown }) => void), off: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name, handler) => { events.handler = handler; return events.off; }) }));
import { resolveExternalFiles } from './externalFileDrop';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); delete (window as unknown as { chrome?: unknown }).chrome; });
function bridge(post: (message: { requestId: string }, files: File[]) => void) {
  Object.assign(window, { chrome: { webview: { postMessageWithAdditionalObjects: post } } });
}
describe('WebView2 external file paths', () => {
  it('passes File objects without reading contents and correlates the native response', async () => {
    const file = new File(['data'], '中文 report.bin', { lastModified: 1700000000000 });
    const read = vi.spyOn(file, 'arrayBuffer');
    bridge((message, files) => {
      expect(files).toEqual([file]);
      events.handler!({ payload: { requestId: 'another-drop', paths: ['wrong'] } });
      events.handler!({ payload: { requestId: message.requestId, paths: ['C:/external/中文 report.bin'] } });
    });
    await expect(resolveExternalFiles([file])).resolves.toEqual([{ path: 'C:/external/中文 report.bin', size: 4, modified: '2023-11-14T22:13:20.000Z' }]);
    expect(read).not.toHaveBeenCalled();
    expect(events.off).toHaveBeenCalledOnce();
  });
  it('refuses partial path results rather than pairing metadata with the wrong source', async () => {
    bridge(message => events.handler!({ payload: { requestId: message.requestId, paths: [] } }));
    await expect(resolveExternalFiles([new File([], 'one')])).rejects.toThrow('Invalid external');
    expect(events.off).toHaveBeenCalledOnce();
  });
  it('surfaces native refusal and cleans the subscription', async () => {
    bridge(message => events.handler!({ payload: { requestId: message.requestId, paths: [], error: 'Not a regular file' } }));
    await expect(resolveExternalFiles([new File([], 'folder')])).rejects.toThrow('Not a regular file');
    expect(events.off).toHaveBeenCalledOnce();
  });
  it('expires unhandled requests and releases the listener', async () => {
    vi.useFakeTimers();
    bridge(() => {});
    const request = resolveExternalFiles([new File([], 'one')]);
    const check = expect(request).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10000);
    await check;
    expect(events.off).toHaveBeenCalledOnce();
  });
  it('releases the listener when WebView2 rejects an unsupported File object', async () => {
    bridge(() => { throw new Error('DataCloneError'); });
    await expect(resolveExternalFiles([new File([], 'one')])).rejects.toThrow('DataCloneError');
    expect(events.off).toHaveBeenCalledOnce();
  });
  it('fails clearly when the native bridge is unavailable', async () => {
    await expect(resolveExternalFiles([new File([], 'one')])).rejects.toThrow('WebView2');
  });
});
