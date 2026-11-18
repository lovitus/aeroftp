// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CI-only release WebView2 OS-backed File bridge smoke (Node 24, no dependencies).
 * This exercises the production additional-objects protocol, not Explorer gestures,
 * the frontend drop UI, remote uploads, or rsync. Never run against a personal app.
 * node scripts/test-windows-external-drop.mjs --exe PATH --evidence DIR
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { exe: { type: 'string' }, evidence: { type: 'string' } }, strict: true });
assert(values.exe && values.evidence, 'Required: --exe PATH --evidence DIR');
assert.equal(process.platform, 'win32', 'This smoke requires real Windows; never skip it');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'CI-only: run in GitHub Actions, never on a personal desktop');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required');

const evidenceDir = path.resolve(values.evidence);
await mkdir(evidenceDir, { recursive: true });
const report = {
  schemaVersion: 1,
  name: 'Windows release WebView2 OS-backed File bridge smoke',
  scope: 'Production native file bridge and ordinary IPC; no Explorer gesture or remote transfer claim',
  startedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  status: 'failed',
  checks: {},
};
let app;
let cdp;
let root;
let exit;
let spawnError;
let interrupted = false;
const signalHandlers = new Map();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const saveReport = () => writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');

// Every CDP command and connection has a deadline, including broken runtime cases.
class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } catch (error) { this.fail(error); }
    });
    socket.addEventListener('close', () => this.fail(new Error('CDP connection closed')));
    socket.addEventListener('error', () => this.fail(new Error('CDP WebSocket error')));
  }
  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect CDP')); }, { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}, timeout = 20000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error('WebView evaluation: ' + JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  close() { this.fail(new Error('Smoke completed')); this.socket.close(); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function requireAlive() {
  if (interrupted) throw new Error('Smoke interrupted');
  if (spawnError) throw spawnError;
  if (exit) throw new Error('Owned AeroFTP exited early: ' + JSON.stringify(exit));
}

async function attachMain(port) {
  const deadline = Date.now() + 90000;
  let lastError;
  while (Date.now() < deadline) {
    requireAlive();
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2000) });
      assert(response.ok, 'CDP discovery HTTP ' + response.status);
      const targets = await response.json();
      report.targets = targets.map(({ id, type, title, url }) => ({ id, type, title, url }));
      for (const target of targets) {
        if (target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
        const url = new URL(target.url);
        if (url.origin !== 'http://tauri.localhost' || /splash|approval/i.test(url.pathname)) continue;
        const wsUrl = new URL(target.webSocketDebuggerUrl);
        assert(['127.0.0.1', 'localhost', '[::1]'].includes(wsUrl.hostname), 'CDP must be loopback');
        assert.equal(Number(wsUrl.port), port, 'Unexpected CDP port');
        const candidate = await CDP.connect(wsUrl.href);
        try {
          const identity = await candidate.evaluate(
            '({origin:location.origin,label:window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label,' +
            'ready:document.readyState,bridge:typeof window.chrome?.webview?.postMessageWithAdditionalObjects,' +
            'invoke:typeof window.__TAURI_INTERNALS__?.invoke,callback:typeof window.__TAURI_INTERNALS__?.transformCallback})');
          if (identity.origin === 'http://tauri.localhost' && identity.label === 'main' &&
              identity.ready === 'complete' && identity.invoke === 'function' && identity.callback === 'function') {
            assert.equal(identity.bridge, 'function', 'WebView2 additional objects API unavailable');
            report.main = { targetId: target.id, url: target.url, ...identity };
            return candidate;
          }
        } catch (error) { candidate.close(); throw error; }
        candidate.close();
      }
    } catch (error) { lastError = String(error); }
    await delay(300);
  }
  throw new Error('Main release WebView2 startup timed out: ' + lastError);
}

async function screenshot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  assert(data, 'Empty screenshot');
  await writeFile(path.join(evidenceDir, name), Buffer.from(data, 'base64'));
}

async function inputFiles(files) {
  const { root: document } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.nodeId, selector: '#aeroftp-ci-file-input' });
  assert(nodeId, 'Fixture input missing');
  await cdp.send('DOM.setFileInputFiles', { nodeId, files });
  return cdp.evaluate('Array.from(document.getElementById("aeroftp-ci-file-input").files, f => ({name:f.name,size:f.size,lastModified:f.lastModified}))');
}

// Matches @tauri-apps/api/event.js: transformCallback -> listen -> post -> unlisten.
// Keep the listener active before posting, and correlate solely by a fresh requestId.
async function bridge(synthetic = false) {
  const requestId = randomUUID();
  return cdp.evaluate('(' + (async function (requestId, synthetic) {
    const api = window.__TAURI_INTERNALS__;
    const event = 'aeroftp:external-drop-resolved';
    let listenerId;
    let timer;
    let complete;
    const response = new Promise(resolve => { complete = resolve; });
    const callbackId = api.transformCallback(message => {
      if (message.payload?.requestId === requestId) complete({ kind: 'native-event', payload: message.payload });
    });
    try {
      listenerId = await api.invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler: callbackId });
      timer = setTimeout(() => complete({ kind: 'timeout' }), 12000);
      try {
        const objects = synthetic
          ? [new File(["synthetic must fail"], "伪造 file.txt")]
          : Array.from(document.getElementById("aeroftp-ci-file-input").files);
        window.chrome.webview.postMessageWithAdditionalObjects({ kind: 'aeroftp.external-drop.resolve', version: 1, requestId }, objects);
      } catch (error) {
        complete({ kind: 'javascript-rejection', error: String(error) });
      }
      return { requestId, ...(await response) };
    } finally {
      clearTimeout(timer);
      if (listenerId !== undefined) {
        window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, listenerId);
        await api.invoke('plugin:event|unlisten', { event, eventId: listenerId });
      }
      api.unregisterCallback(callbackId);
    }
  }).toString() + ')(' + JSON.stringify(requestId) + ',' + JSON.stringify(synthetic) + ')');
}

function assertRejected(result, name) {
  assert.notEqual(result.kind, 'timeout', name + ': timeout is not evidence of rejection');
  if (result.kind === 'javascript-rejection') { assert(result.error, name + ': missing exception'); return; }
  assert.equal(result.kind, 'native-event', name + ': no native response');
  assert.equal(result.payload.requestId, result.requestId);
  assert.equal(typeof result.payload.error, 'string', name + ': expected native error');
  assert(result.payload.error.length > 0, name + ': empty native error');
  assert.deepEqual(result.payload.paths, [], name + ': rejected objects must expose no paths');
}

async function stopOwned() {
  if (!app?.pid || exit || spawnError) return;
  // /PID, never /IM: the child handle still owns this live PID. /T includes only
  // its WebView2 descendants, not an already-running user's AeroFTP instance.
  report.cleanup = { pid: app.pid, method: 'taskkill /PID owned-child /T /F' };
  await new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { killer.kill(); reject(new Error('Owned process cleanup timed out')); }, 15000);
    killer.once('error', error => { clearTimeout(timer); reject(error); });
    killer.once('exit', code => {
      clearTimeout(timer);
      if (code === 0 || exit) resolve();
      else reject(new Error('Owned process tree cleanup failed: ' + code));
    });
  });
  const deadline = Date.now() + 5000;
  while (!exit && Date.now() < deadline) await delay(50);
  assert(exit, 'Owned application did not exit after cleanup');
}

try {
  const sourceExe = await realpath(path.resolve(values.exe));
  assert((await stat(sourceExe)).isFile(), '--exe must be a regular release executable');
  assert.equal(path.extname(sourceExe).toLowerCase(), '.exe');
  root = await mkdtemp(path.join(os.tmpdir(), 'aeroftp-windows-file-bridge-'));
  const portable = path.join(root, 'portable');
  const sourceDir = path.dirname(sourceExe);
  // Copy only the build package, never copy/read an existing portable data/vault.
  // CLI, icons and runtime DLLs are retained alongside the GUI executable.
  await cp(sourceDir, portable, { recursive: true, dereference: false, filter: source => {
    const relative = path.relative(sourceDir, source);
    const first = relative.split(path.sep)[0].toLowerCase();
    return !['data', 'node_modules', 'target', '.git'].includes(first);
  } });
  await writeFile(path.join(portable, 'portable.marker'), 'CI isolated OS-backed File bridge smoke\n');
  const isolatedExe = path.join(portable, path.basename(sourceExe));
  const env = { ...process.env };
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'TEMP', 'TMP']) {
    env[key] = path.join(root, 'environment', key.toLowerCase());
    await mkdir(env[key], { recursive: true });
  }
  const port = await freePort();
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1';
  env.WEBVIEW2_USER_DATA_FOLDER = path.join(portable, 'data', 'webview');
  report.launch = { sourceExe, isolatedExe, root, port, arguments: env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, exeSha256: sha256(await readFile(isolatedExe)) };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => { interrupted = true; cdp?.close(); };
    process.on(signal, handler);
    signalHandlers.set(signal, handler);
  }
  app = spawn(isolatedExe, [], { cwd: portable, env, windowsHide: false, stdio: 'ignore' });
  app.once('error', error => { spawnError = error; });
  app.once('exit', (code, signal) => { exit = { code, signal }; });
  report.launch.pid = app.pid;
  cdp = await attachMain(port);
  await cdp.send('Page.enable');
  report.browser = await cdp.send('Browser.getVersion');
  await screenshot('01-main-release.png');
  const ipcBefore = await cdp.evaluate('window.__TAURI_INTERNALS__.invoke("portable_info")');
  report.checks.ipcBefore = ipcBefore;
  assert.equal(ipcBefore.is_portable, true, 'Application must be portable');
  assert.equal(path.resolve(ipcBefore.data_root).toLowerCase(), path.join(portable, 'data').toLowerCase(), 'Portable data must be isolated');
  assert.equal(path.resolve(ipcBefore.credential_store_dir).toLowerCase(), path.join(portable, 'data', 'aeroftp').toLowerCase(), 'Release credential directory must be isolated');
  assert.equal(path.resolve(ipcBefore.webview_data_dir).toLowerCase(), path.join(portable, 'data', 'webview').toLowerCase(), 'WebView data must be isolated');
  assert((await stat(path.join(portable, 'data', 'aeroftp'))).isDirectory(), 'Release data leaf missing');
  await cdp.evaluate('(() => { const input = document.createElement("input"); input.id = "aeroftp-ci-file-input"; input.type = "file"; input.multiple = true; input.setAttribute("aria-label", "CI OS-backed File bridge fixture"); document.body.appendChild(input); return true; })()');
  const fixtureDir = path.join(root, '真实 文件 fixtures');
  await mkdir(fixtureDir);
  const fixturePaths = [path.join(fixtureDir, '第二 空格.bin'), path.join(fixtureDir, '第一 中文.txt')];
  const fixtureContents = [Buffer.from([0, 255, 13, 10, 128, 1, 2, 3]), Buffer.from('真实 Windows 文件桥\nspaces and 中文\n', 'utf8')];
  for (let i = 0; i < fixturePaths.length; i++) await writeFile(fixturePaths[i], fixtureContents[i]);
  const expected = await Promise.all(fixturePaths.map(async file => {
    const info = await stat(file);
    return { path: file, name: path.basename(file), size: info.size, lastModified: Math.trunc(info.mtimeMs), sha256: sha256(await readFile(file)) };
  }));
  const selected = await inputFiles(fixturePaths);
  assert.equal(selected.length, expected.length, 'CDP did not supply both OS-backed Files');
  const realFiles = await bridge();
  report.checks.realFiles = { expected, selected, response: realFiles };
  assert.equal(realFiles.kind, 'native-event');
  assert.equal(realFiles.payload.requestId, realFiles.requestId);
  assert(!realFiles.payload.error, 'Native file resolution rejected real files: ' + realFiles.payload.error);
  assert.deepEqual(realFiles.payload.paths, fixturePaths, 'Exact Unicode paths and order must survive native COM bridge');
  const browserContents = await cdp.evaluate('(async () => Promise.all(Array.from(document.getElementById("aeroftp-ci-file-input").files, async f => Array.from(new Uint8Array(await f.arrayBuffer())))))()');
  for (let i = 0; i < expected.length; i++) {
    assert.equal(selected[i].name, expected[i].name);
    assert.equal(selected[i].size, expected[i].size);
    assert(Math.abs(selected[i].lastModified - expected[i].lastModified) <= 1, 'OS-backed lastModified mismatch');
    assert.equal(sha256(Buffer.from(browserContents[i])), expected[i].sha256, 'File bytes differ from disk');
    assert.equal((await stat(realFiles.payload.paths[i])).size, expected[i].size);
  }
  report.checks.realFiles.browserSha256 = browserContents.map(bytes => sha256(Buffer.from(bytes)));
  const fake = await bridge(true);
  report.checks.syntheticFileRejected = fake;
  assertRejected(fake, 'Synthetic File');
  const directory = path.join(fixtureDir, '目录 empty');
  await mkdir(directory);
  // Some Chromium versions refuse directories at DOM.setFileInputFiles itself.
  // That is explicitly recorded as a CDP limitation, never as native rejection.
  let directoryFiles;
  try { directoryFiles = await inputFiles([directory]); }
  catch (error) {
    // Only an explicit directory/file-type refusal is a fixture limitation.
    // Connection errors, deadlines, missing DOM and other failures stay fatal.
    if (!/director(?:y|ies)|not (?:a |an? ordinary |a regular )?file/i.test(String(error))) throw error;
    report.checks.directory = { outcome: 'cdp-cannot-create-directory-file', detail: String(error), nativeRejectionProven: false };
  }
  if (directoryFiles) {
    assert.equal(directoryFiles.length, 1, 'CDP accepted directory command but provided no real directory File');
    const response = await bridge();
    report.checks.directory = { selected: directoryFiles, response, nativeRejectionProven: response.kind === 'native-event' };
    assertRejected(response, 'Directory File');
    if (response.kind === 'native-event') assert.equal(response.payload.error, 'not_a_regular_file');
  }
  const ipcAfter = await cdp.evaluate('window.__TAURI_INTERNALS__.invoke("portable_info")');
  report.checks.ipcAfter = ipcAfter;
  assert.deepEqual(ipcAfter, ipcBefore, 'Ordinary Tauri IPC changed after bridge requests');
  await screenshot('02-after-file-bridge.png');
  requireAlive();
  report.status = 'passed';
} catch (error) {
  report.error = { message: String(error), stack: error?.stack };
  if (cdp) {
    try { await screenshot('failure.png'); }
    catch (screenshotError) { report.screenshotError = String(screenshotError); }
  }
  process.exitCode = 1;
} finally {
  cdp?.close();
  try { await stopOwned(); }
  catch (error) { report.cleanupError = String(error); report.status = 'failed'; process.exitCode = 1; }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  report.exit = exit;
  report.finishedAt = new Date().toISOString();
  // Keep only this fresh CI fixture until runner teardown for diagnosis. Never
  // recursively delete a supplied executable/evidence directory or another app.
  report.fixtureRetainedUntilRunnerTeardown = root;
  await saveReport();
}
console.log(JSON.stringify({ status: report.status, evidence: evidenceDir, error: report.error?.message }));
