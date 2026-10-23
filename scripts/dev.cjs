const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = fs.realpathSync(path.resolve(__dirname, '..'));
let server, desktop, stopped = false, restarting = false, changed = false, timer;
const watchers = [];
const sources = new Set(['app_server.py', 'catalog.py', 'embed.py', 'model_assets.py', 'model_worker.py', 'search_matching.py',
  'material_assets.py', 'material_catalog.py', 'material_worker.py', 'blender_material.py']);

function launch() {
  if (stopped) return;
  const env = { ...process.env, PRISM_DEV_URL: server.resolvedUrls.local[0] };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = spawn(require('electron'), [root], { cwd: root, env, stdio: 'inherit' });
  desktop.once('error', error => { console.error(error.message); finish(1); });
  desktop.once('exit', code => {
    desktop = null;
    if (stopped) return;
    if (restarting) {
      restarting = false;
      changed = false;
      launch();
    } else {
      finish(code || 0);
    }
  });
}

function sourceChanged() {
  if (stopped) return;
  changed = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!changed || restarting || !desktop) return;
    restarting = true;
    console.log('后端代码已修改，重启开发窗口与本地服务…');
    desktop.kill('SIGTERM');
  }, 400);
}

async function finish(code = 0) {
  if (stopped) return;
  stopped = true;
  clearTimeout(timer);
  watchers.forEach(watcher => watcher.close());
  if (desktop) desktop.kill('SIGTERM');
  if (server) await server.close();
  process.exitCode = code;
}

(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 5173, strictPort: false } });
  await server.listen();
  console.log(`Prism 开发版：${server.resolvedUrls.local[0]}`);
  console.log('界面修改自动更新；后端修改自动重启；复用项目模型与现有素材库。');
  watchers.push(fs.watch(root, (_, name) => { if (name && sources.has(String(name))) sourceChanged(); }));
  watchers.push(fs.watch(path.join(root, 'electron'), (_, name) => {
    if (name && String(name).endsWith('.cjs')) sourceChanged();
  }));
  launch();
})().catch(error => { console.error(error); finish(1); });
process.once('SIGINT', () => finish());
process.once('SIGTERM', () => finish());
