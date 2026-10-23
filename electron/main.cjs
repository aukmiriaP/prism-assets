const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { modelDirectory } = require('./model-path.cjs');

app.setName('Prism Assets');
if (process.env.PRISM_USER_DATA) app.setPath('userData', process.env.PRISM_USER_DATA);
const devUrl = !app.getAppPath().endsWith('.asar') && process.env.PRISM_DEV_URL || '';
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl)) {
  throw new Error('开发界面地址必须为本机 127.0.0.1 HTTP 服务');
}
let window, service, endpoint, ready, quitting = false, log;
const token = crypto.randomBytes(32).toString('hex');

function startService() {
  const base = path.resolve(__dirname, '..');
  const packaged = app.getAppPath().endsWith('.asar');
  const dataDir = process.env.PRISM_DATA_DIR || path.join(app.getPath('userData'), 'library');
  fs.mkdirSync(dataDir, { recursive: true });
  log = fs.createWriteStream(path.join(dataDir, 'service.log'), { flags: 'w', mode: 0o600 });
  const executable = packaged
    ? path.join(process.resourcesPath, 'service', 'prism-service', 'prism-service')
    : path.join(base, '.venv', 'bin', 'python');
  const args = packaged ? [] : [path.join(base, 'app_server.py')];
  const modelDir = modelDirectory({ override: process.env.PRISM_MODEL_DIR, packaged,
    resourcesPath: process.resourcesPath, base });
  service = spawn(executable, args, {
    cwd: dataDir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PRISM_DATA_DIR: dataDir, PRISM_TOKEN: token,
      PRISM_MODEL_DIR: modelDir, PRISM_DEV_URL: devUrl, PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1' }
  });
  ready = new Promise((resolve, reject) => {
    let buffer = '', settled = false;
    const timer = setTimeout(() => finish(new Error('本地服务启动超时，请查看数据目录中的 service.log')), 90000);
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve({ base: endpoint, token });
    };
    service.on('error', finish);
    service.on('exit', (code) => {
      endpoint = null;
      finish(new Error(`本地服务已退出（${code}），请重新启动应用。`));
      if (!quitting) window?.webContents.send('service-error', '本地服务已退出，请重新启动应用。');
    });
    service.stderr.on('data', chunk => log.write(chunk));
    service.stdout.on('data', chunk => {
      log.write(chunk);
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('PRISM_ENDPOINT=')) {
          endpoint = `http://127.0.0.1:${JSON.parse(line.slice(15)).port}`;
          const check = async () => {
            if (settled) return;
            try {
              const response = await fetch(`${endpoint}/health`, { headers: { Authorization: `Bearer ${token}` } });
              if (response.ok) return finish();
            } catch {}
            setTimeout(check, 200);
          };
          check();
        }
      }
    });
  });
  // The renderer handles this same promise; avoid an early unhandled rejection.
  ready.catch(() => {});
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1040, minHeight: 680,
    title: 'Prism Assets', backgroundColor: '#101113',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!devUrl || url !== devUrl) event.preventDefault();
  });
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error('无效的应用窗口');
}
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => { trusted(event); return fn(...args); });
}
handle('connection', async () => ready);
handle('api', async (route, method = 'GET', body) => {
  await ready;
  if (!endpoint) throw new Error('本地服务已退出，请重新启动应用');
  const directoryRead = method === 'GET' && typeof route === 'string' &&
    /^\/folders\/[a-zA-Z0-9_-]+\/directories\?parent=(?:[a-zA-Z0-9_.!~*'()-]|%[a-fA-F0-9]{2})*$/.test(route);
  if (typeof route !== 'string' || (!directoryRead && !/^\/(summary|health|search|folders|assets|collections|materials)(\/[a-zA-Z0-9_-]+)*$/.test(route))
    || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('无效请求');
  const response = await fetch(endpoint + route, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(310000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '请求参数无效');
  return result;
});
handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'multiSelections'],
    title: '关联素材文件夹', buttonLabel: '关联文件夹' });
  return result.canceled ? [] : result.filePaths;
});
handle('choose-image', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openFile'], title: '选择参考图片',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp'] }] });
  return result.canceled ? null : result.filePaths[0];
});
handle('choose-material', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'],
    title: '导入 PBR 材质包', buttonLabel: '选择贴图文件夹' });
  return result.canceled ? null : result.filePaths[0];
});
handle('export-material', async aid => {
  await ready;
  if (!/^[a-f0-9]{32}$/.test(aid)) throw new Error('材质不存在');
  const headers = { Authorization: `Bearer ${token}` };
  const assetResponse = await fetch(`${endpoint}/assets/${aid}`, { headers });
  if (!assetResponse.ok) throw new Error('材质不存在');
  const asset = await assetResponse.json();
  if (asset.kind !== 'material') throw new Error('请选择 PBR 材质');
  const result = await dialog.showSaveDialog(window, { title: '导出 Blender 材质包',
    defaultPath: `${asset.name.replace(/[\\/:\0]/g, '_')}.prism-pbr.zip`,
    filters: [{ name: 'Prism PBR 材质包', extensions: ['zip'] }] });
  if (result.canceled || !result.filePath) return null;
  const response = await fetch(`${endpoint}/assets/${aid}/material/export`, { headers,
    signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    const error = await response.json(); throw new Error(error.detail || '材质导出失败');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  // A sibling temporary file prevents a failed write from replacing an existing export.
  const temporary = `${result.filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporary, buffer, { flag: 'wx' });
    await fs.promises.rename(temporary, result.filePath);
  } finally { await fs.promises.rm(temporary, { force: true }); }
  return result.filePath;
});
handle('reveal', async value => { if (typeof value === 'string') shell.showItemInFolder(value); });
handle('open-file', async aid => {
  await ready;
  if (!/^[a-f0-9]{32}$/.test(aid)) throw new Error('素材不存在');
  const response = await fetch(`${endpoint}/assets/${aid}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('素材不存在');
  const asset = await response.json();
  const result = await shell.openPath(asset.path);
  if (result) throw new Error(result);
});
handle('copy', async value => { if (typeof value === 'string') clipboard.writeText(value); });
handle('restart', () => { app.relaunch(); app.quit(); });
handle('confirm-detach', async name => {
  const result = await dialog.showMessageBox(window, { type: 'question', buttons: ['取消', '解除关联'],
    defaultId: 0, cancelId: 0, message: `解除“${name}”的关联？`,
    detail: '将移除这个目录的索引、收藏和标签。原始文件不受影响。' });
  return result.response === 1;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Prism Assets', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'togglefullscreen' }] }
    ]));
    startService(); createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  if (devUrl) {
    // The development runner restarts only its own Electron child after Python edits.
    process.on('SIGTERM', () => app.quit());
    process.on('SIGINT', () => app.quit());
  }
  app.on('before-quit', event => {
    if (quitting || !service || service.exitCode !== null) return;
    event.preventDefault();
    quitting = true;
    service.kill('SIGTERM');
    const timer = setTimeout(() => { service.kill('SIGKILL'); app.quit(); }, 2500);
    service.once('exit', () => { clearTimeout(timer); app.quit(); });
  });
}
