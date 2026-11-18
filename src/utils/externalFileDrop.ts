// SPDX-License-Identifier: GPL-3.0-or-later

import { listen } from '@tauri-apps/api/event';

export interface ExternalUploadFile {
  path: string;
  size: number;
  modified: string | null;
}

interface ResolvedDrop {
  requestId: string;
  paths: string[];
  error?: string | null;
}

type FileBridge = {
  postMessageWithAdditionalObjects(message: string, objects: File[]): void;
};

/** Resolve real disk paths without reading/staging file contents or disabling HTML5 DnD. */
export async function resolveExternalFiles(files: readonly File[]): Promise<ExternalUploadFile[]> {
  if (!files.length || files.length > 1024) throw new Error('Drop between 1 and 1024 files');
  const bridge = (window as unknown as { chrome?: { webview?: FileBridge } }).chrome?.webview;
  if (!bridge?.postMessageWithAdditionalObjects) {
    throw new Error('External file drops require a supported WebView2 runtime');
  }
  const requestId = crypto.randomUUID();
  let unlisten: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ExternalUploadFile[]>((resolve, reject) => {
      // Register before posting: native resolution can complete immediately.
      void listen<ResolvedDrop>('aeroftp:external-drop-resolved', ({ payload }) => {
        if (payload.requestId !== requestId) return;
        if (payload.error) { reject(new Error(payload.error)); return; }
        if (!Array.isArray(payload.paths) || payload.paths.length !== files.length ||
            payload.paths.some(path => typeof path !== 'string' || !path)) {
          reject(new Error('Invalid external file drop response'));
          return;
        }
        resolve(payload.paths.map((path, index) => ({
          path,
          size: files[index].size,
          modified: files[index].lastModified > 0 ? new Date(files[index].lastModified).toISOString() : null,
        })));
      }).then(off => {
        unlisten = off;
        timeout = setTimeout(() => reject(new Error('External file drop resolution timed out')), 10000);
        try {
          // Wry's earlier WebMessageReceived handler reads strings. An object
          // message fails there before our native file handler can receive it.
          bridge.postMessageWithAdditionalObjects(JSON.stringify({ kind: 'aeroftp.external-drop.resolve', version: 1, requestId }), [...files]);
        } catch (error) { reject(error); }
      }, reject);
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unlisten?.();
  }
}
