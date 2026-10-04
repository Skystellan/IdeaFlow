import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = path.dirname(fileURLToPath(import.meta.url));
const scheme = 'idea-workbench';
const homeURL = `${scheme}://home/`;
app.setName('IdeaFlow');
nativeTheme.themeSource = 'light';
// Keep the existing profile and URL scheme so layouts and drafts survive the rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Idea Workbench'));
protocol.registerSchemesAsPrivileged([{ scheme, privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);
let window, active, busy = false, quitting = false;
let recent = [];
const children = new Set();
const configFile = path.join(app.getPath('userData'), 'projects.json');

function ownsURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === `${scheme}:` && (url.host === 'home' || url.host === active?.host);
  } catch { return false; }
}

function stopBackend(backend) {
  if (!backend) return;
  backend.stopping = true;
  backend.child.stdin.end();
  const timer = setTimeout(() => backend.child.kill('SIGTERM'), 2000);
  timer.unref();
  backend.child.once('exit', () => clearTimeout(timer));
}

function startBackend(projectPath, create) {
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'workbench-backend', 'workbench-backend')
    : process.env.IDEA_WORKBENCH_PYTHON || 'python3';
  const args = app.isPackaged ? [] : ['-m', 'idea_workbench.desktop_backend'];
  args.push('--project', projectPath);
  if (create) args.push('--create');
  const child = spawn(executable, args, {
    cwd: app.isPackaged ? app.getPath('userData') : path.resolve(here, '../..'),
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const backend = { child, stopping: false };
  children.add(backend);
  return new Promise((resolve, reject) => {
    let errors = '', ready = false;
    const timer = setTimeout(() => {
      stopBackend(backend);
      reject(new Error('本地服务启动超时，请重新打开项目。'));
    }, 20000);
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    // A failed child may close stdin before the parent requests shutdown.
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); children.delete(backend); reject(error); });
    child.once('exit', () => {
      clearTimeout(timer);
      children.delete(backend);
      if (!ready) reject(new Error(errors.trim() || '无法启动项目服务。'));
      else if (!backend.stopping && !quitting && active === backend) {
        dialog.showErrorBox('项目服务已停止', '已保存的记录仍在项目目录中。请从“文件”菜单重新打开项目。');
      }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (ready) return;
      try {
        const info = JSON.parse(line);
        const endpoint = new URL(info.url);
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || !info.store || !info.project?.name) throw new Error('Invalid backend response');
        Object.assign(backend, info, { host: `p-${createHash('sha256').update(info.store).digest('hex').slice(0, 24)}` });
        ready = true;
        clearTimeout(timer);
        resolve(backend);
      } catch (error) { stopBackend(backend); clearTimeout(timer); reject(error); }
    });
  });
}

async function remember(backend) {
  recent = [{ path: backend.store, name: backend.project.name }, ...recent.filter(item => item.path !== backend.store)].slice(0, 10);
  await writeFile(`${configFile}.tmp`, JSON.stringify(recent, null, 2), { mode: 0o600 });
  await rename(`${configFile}.tmp`, configFile);
  installMenu();
}

async function openProject(projectPath, create = false) {
  if (busy || quitting) return;
  busy = true;
  let next;
  const previous = active;
  try {
    next = await startBackend(projectPath, create);
    if (quitting) { stopBackend(next); return; }
    active = next;
    await window.loadURL(`${scheme}://${next.host}/`);
    window.setTitle(`${next.project.name} — IdeaFlow`);
    stopBackend(previous);
    await remember(next);
  } catch (error) {
    if (next && active === next && !window.webContents.getURL().startsWith(`${scheme}://${next.host}/`)) {
      stopBackend(next);
      active = previous;
    }
    if (!quitting) await dialog.showMessageBox(window, { type: 'error', message: '无法打开研究项目', detail: error.message });
  } finally { busy = false; }
}

async function chooseProject(create = false) {
  if (busy) return;
  const result = await dialog.showOpenDialog(window, {
    title: create ? '选择用于新研究的项目文件夹' : '打开已有研究项目',
    message: create ? '在所选文件夹中建立研究记录；已有文件会保留。' : '选择包含 .idea-workbench 的项目文件夹，或记录目录本身。',
    buttonLabel: create ? '建立研究' : '打开研究',
    properties: ['openDirectory', ...(create ? ['createDirectory'] : [])],
  });
  if (!result.canceled) await openProject(result.filePaths[0], create);
}

async function exportProject() {
  const backend = active;
  if (!backend) return;
  const result = await dialog.showSaveDialog(window, {
    title: '导出研究记录', defaultPath: 'ideaflow.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled) return;
  try {
    const response = await net.fetch(`${backend.url}/api/export`);
    if (!response.ok) throw new Error('读取研究记录失败');
    await writeFile(result.filePath, JSON.stringify(await response.json(), null, 2), { mode: 0o600 });
  } catch (error) { await dialog.showMessageBox(window, { type: 'error', message: '导出失败', detail: error.message }); }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '文件', submenu: [
      { label: '打开研究项目…', accelerator: 'CmdOrCtrl+O', click: () => chooseProject() },
      { label: '新建研究项目…', accelerator: 'CmdOrCtrl+N', click: () => chooseProject(true) },
      { label: '最近项目', submenu: recent.length ? recent.map(item => ({ label: item.name.replaceAll('&', '&&'), sublabel: item.path, click: () => openProject(item.path) })) : [{ label: '还没有最近项目', enabled: false }] },
      { type: 'separator' },
      { label: '在 Finder 中显示项目', enabled: Boolean(active), click: () => shell.showItemInFolder(active.store) },
      { label: '导出研究记录…', enabled: Boolean(active), accelerator: 'CmdOrCtrl+Shift+E', click: exportProject },
      { type: 'separator' }, { role: 'close' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]));
}

async function handleProtocol(request) {
  const url = new URL(request.url);
  if (!ownsURL(url.href) || (request.initiatorOrigin && !ownsURL(request.initiatorOrigin))) return new Response('Forbidden', { status: 403 });
  if (url.host === 'home') {
    const files = { '/': ['welcome.html', 'text/html'], '/welcome.css': ['welcome.css', 'text/css'], '/welcome.js': ['welcome.js', 'text/javascript'] };
    const file = files[url.pathname];
    if (!file || request.method !== 'GET') return new Response('Not found', { status: 404 });
    return new Response(await readFile(path.join(here, file[0])), { headers: {
      'Content-Type': `${file[1]}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    } });
  }
  const backend = active;
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const headers = { Origin: backend.url };
  for (const name of ['Content-Type', 'X-Idea-Token']) {
    if (request.headers.has(name)) headers[name] = request.headers.get(name);
  }
  let body;
  if (request.method !== 'GET') {
    body = await request.arrayBuffer();
    if (body.byteLength > 1024 * 1024) return new Response('Request too large', { status: 413 });
  }
  try {
    // Concatenation deliberately keeps paths on our owned loopback service.
    // Chromium's client avoids Node/Undici's paused-stream assertion on loopback EOF.
    const response = await net.fetch(`${backend.url}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: 'error' });
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch { return new Response('项目服务暂时不可用，请重新打开项目。', { status: 503 }); }
}

function registerIPC() {
  for (const [command, handler] of Object.entries({
    open: () => chooseProject(), create: () => chooseProject(true), export: exportProject,
    recent: () => recent,
    'open-recent': index => {
      if (!Number.isInteger(index) || !recent[index]) throw new Error('Invalid recent project');
      return openProject(recent[index].path);
    },
  })) {
    ipcMain.handle(`desktop:${command}`, (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !ownsURL(event.senderFrame.url)) throw new Error('Untrusted window');
      return handler(...args);
    });
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', () => { quitting = true; for (const backend of children) stopBackend(backend); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true });
    try {
      const value = JSON.parse(await readFile(configFile, 'utf8'));
      if (Array.isArray(value)) recent = value.filter(item => typeof item?.path === 'string' && typeof item?.name === 'string').slice(0, 10);
    } catch { /* First launch, or a damaged recent list: project databases are independent. */ }
    protocol.handle(scheme, handleProtocol);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window?.webContents && ownsURL(contents.getURL()) && permission === 'clipboard-sanitized-write'));
    session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === window?.webContents && ownsURL(contents.getURL()) && permission === 'clipboard-sanitized-write');
    window = new BrowserWindow({
      width: 1440, height: 920, minWidth: 1000, minHeight: 640, show: false,
      title: 'IdeaFlow', backgroundColor: '#f4f5f7',
      webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!ownsURL(url)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('page-title-updated', event => event.preventDefault());
    registerIPC();
    installMenu();
    await window.loadURL(homeURL);
    window.show();
    const argIndex = process.argv.indexOf('--project');
    if (argIndex >= 0 && process.argv[argIndex + 1]) await openProject(process.argv[argIndex + 1]);
    else if (recent[0]) await openProject(recent[0].path);
  }).catch(error => { dialog.showErrorBox('IdeaFlow 启动失败', error.message); app.quit(); });
}
