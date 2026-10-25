const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-motion-ui-'));
const output = process.env.PRISM_TEST_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
execFileSync(path.join(root, '.venv/bin/python'), [path.join(root, 'tests/motion-fixture.py'), path.join(temp, 'library')], { cwd: root });
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: path.join(temp, 'library') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'PRISM_DEV_URL', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) delete env[key];
let instance, page;
const errors = [];
function pixelDifference(before, after) {
  const left = path.join(temp, 'compare-before.png'), right = path.join(temp, 'compare-after.png');
  fs.writeFileSync(left, before); fs.writeFileSync(right, after);
  return Number(execFileSync(path.join(root, '.venv/bin/python'), ['-c', `
import sys,numpy as np
from PIL import Image
a,b=[np.asarray(Image.open(p).convert("RGB")).astype(np.int16) for p in sys.argv[1:]]
print(np.mean(np.max(np.abs(a-b),axis=2)>8))
`, left, right], { encoding: 'utf8' }));
}
const viewer = () => page.getByRole('dialog', { name: '人形动作预览', exact: true });
const modelViewer = () => page.getByRole('dialog', { name: '3D 模型预览', exact: true });
async function openModel() {
  await page.getByRole('button', { name: /^3D 模型/ }).click();
  await page.getByRole('button', { name: '模型分组 鸣潮_锁暝1.0.pmx', exact: true }).click();
  await page.getByRole('button', { name: '素材 鸣潮_锁暝1.0.pmx', exact: true }).dblclick();
  await expect(modelViewer()).toBeVisible();
  await expect(modelViewer().locator('.model-loading')).toHaveCount(0, { timeout: 60000 });
}
async function sameCanvas() {
  expect(await page.evaluate(() => document.querySelector('.preview-canvas canvas') === window.__previewCanvas)).toBe(true);
}
const rememberCanvas = () => page.evaluate(() => { window.__previewCanvas = document.querySelector('.preview-canvas canvas'); });
async function changeTheme(mode) {
  await page.emulateMedia({ colorScheme: mode });
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
}
const ready = async () => {
  await expect(viewer()).toBeVisible({ timeout: 10000 });
  await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  await expect(viewer().locator('.motion-loading')).toHaveCount(0);
};
async function shot(name) {
  await page.waitForTimeout(250); // Allow native compositor to present React + WebGL changes.
  const data = await instance.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus();
    return (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(output, name), Buffer.from(data, 'base64'));
}
async function frame(number) {
  await viewer().getByRole('slider', { name: '动作时间轴' }).fill(String(number));
  await expect(viewer().locator('.motion-playback output')).toContainText(`第 ${number} /`);
}
async function launch(environment = env) {
  instance = await electron.launch({ args: [path.join(root, 'tests/material-ui-main.cjs')], cwd: root, env: environment, timeout: 60000 });
  page = await instance.firstWindow();
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.__physicsWorkers = new Set();
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        if (window.__failPhysicsWorker) throw new Error('测试：物理线程不可用');
        super(...args); window.__physicsWorkers.add(this);
      }
      terminate() { window.__physicsWorkers.delete(this); return super.terminate(); }
    };
  });
  page.on('pageerror', e => { errors.push(e.message); console.error('RENDERER_ERROR', e.message); });
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) errors.push('external request'); });
  await instance.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.setSize(1440, 940); win.webContents.setBackgroundThrottling(false);
  });
  await expect(page.getByRole('button', { name: /^动作\s*\d/ })).toBeVisible({ timeout: 60000 });
}
(async () => {
  try {
    // A fresh library with no PMX at all must still render and animate immediately.
    await launch({ ...env, PRISM_DATA_DIR: path.join(temp, 'motion-only'),
      PRISM_USER_DATA: path.join(temp, 'motion-only-electron') });
    const modelRequests = [];
    page.on('request', request => { if (/\/motion-model|\/motion-textures/.test(request.url())) modelRequests.push(request.url()); });
    await page.evaluate(async source => window.prism.api('/folders', 'POST', { path: source }), path.join(root, '../datasets/motion'));
    await expect.poll(async () => page.evaluate(async () => (await window.prism.api('/summary')).motions)).toBe(3);
    await page.getByRole('button', { name: /^动作\s*\d/ }).click();
    await page.getByRole('button', { name: '动作包 EX_HAPPY', exact: true }).click();
    await page.getByRole('button', { name: '素材 motion.vmd', exact: true }).dblclick();
    await ready();
    await expect(viewer().getByLabel('预览角色')).toHaveValue('builtin-prism-mannequin');
    await expect(viewer().getByLabel('预览角色').locator('option')).toHaveCount(1);
    await expect(viewer().getByLabel('头发与衣裙物理')).toBeDisabled();
    await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-physics', 'unavailable');
    await expect(viewer().locator('.motion-stage-label')).toContainText('50 / 50');
    await expect(viewer().getByLabel('地面网格')).not.toBeChecked();
    await frame(150); await shot('prism-motion-default-light.png');
    await viewer().getByLabel('地面网格').check();
    await page.keyboard.press('Escape');
    await page.evaluate(() => localStorage.setItem('prism.motion-model.v1', 'removed-model-id'));
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.locator('.inspector-preview').click(); await ready();
    await expect(viewer().getByLabel('预览角色')).toHaveValue('builtin-prism-mannequin');
    await expect(viewer().getByLabel('地面网格')).toBeChecked();
    await viewer().getByLabel('地面网格').uncheck();
    await frame(120); await shot('prism-motion-default-dark.png');
    expect(modelRequests).toEqual([]);
    await instance.close();
    await launch();
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('button', { name: '跟随系统', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await changeTheme('light');
    const assetRequests = [];
    page.on('request', request => {
      if (/\/assets\/.*\/(model|motion|motion-model|motion-textures)(\?|\/|$)/.test(request.url())) assetRequests.push(request.url());
    });
    await openModel(); await rememberCanvas();
    await expect(modelViewer().getByLabel('地面网格')).not.toBeChecked();
    await expect(modelViewer().getByLabel('地面阴影')).toBeChecked();
    await shot('prism-shared-model-light.png');
    const staticCanvas = modelViewer().locator('canvas');
    const litModel = await staticCanvas.screenshot();
    const requestCount = assetRequests.length;
    await modelViewer().getByLabel('地面阴影').uncheck();
    expect(pixelDifference(litModel, await staticCanvas.screenshot())).toBeGreaterThan(.001);
    await modelViewer().getByLabel('地面阴影').check();
    await expect.poll(async () => pixelDifference(litModel, await staticCanvas.screenshot())).toBeLessThan(.001);
    const box = await staticCanvas.boundingBox();
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .5);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .65, box.y + box.height * .5, { steps: 15 }); await page.mouse.up();
    // Damping converges per rendered frame, not wall time (GPU load varies).
    await page.evaluate(() => new Promise(resolve => {
      let frames = 0;
      const step = () => { if (++frames >= 320) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }));
    const rotated = await staticCanvas.screenshot();
    expect(pixelDifference(litModel, rotated)).toBeGreaterThan(.01);
    await modelViewer().getByLabel('地面网格').check();
    expect(pixelDifference(rotated, await staticCanvas.screenshot())).toBeGreaterThan(.001);
    await modelViewer().getByLabel('地面网格').uncheck();
    // Permit subpixel/alpha-hash edge noise while detecting a changed camera or environment.
    await expect.poll(async () => pixelDifference(rotated, await staticCanvas.screenshot())).toBeLessThan(.001);
    await modelViewer().getByLabel('线框', { exact: true }).check();
    const wireframe = await staticCanvas.screenshot();
    expect(pixelDifference(rotated, wireframe)).toBeGreaterThan(.001);
    await modelViewer().getByLabel('隔离材质').selectOption({ index: 1 });
    expect(pixelDifference(wireframe, await staticCanvas.screenshot())).toBeGreaterThan(.001);
    await changeTheme('dark'); await sameCanvas();
    await expect(modelViewer().getByLabel('线框', { exact: true })).toBeChecked();
    await expect(modelViewer().getByLabel('隔离材质')).not.toHaveValue('');
    await modelViewer().getByLabel('线框', { exact: true }).uncheck();
    await modelViewer().getByRole('button', { name: '复位视角' }).click();
    await expect(modelViewer().getByLabel('隔离材质')).toHaveValue('');
    await shot('prism-shared-model-dark.png');
    await changeTheme('light');
    await expect.poll(async () => pixelDifference(litModel, await staticCanvas.screenshot())).toBeLessThan(.001);
    await sameCanvas(); expect(assetRequests.length).toBe(requestCount);
    // Preferences made in a model preview must carry into a newly opened motion preview.
    await modelViewer().getByLabel('地面网格').check();
    await modelViewer().getByLabel('地面阴影').uncheck();
    await page.keyboard.press('Escape');
    await expect(page.locator('.model-canvas canvas')).toHaveCount(0);
    await page.evaluate(async source => window.prism.api('/folders', 'POST', { path: source }), path.join(root, '../datasets/motion'));
    await expect.poll(async () => page.evaluate(async () => (await window.prism.api('/summary')).motions), { timeout: 60000 }).toBe(3);
    await page.getByRole('button', { name: /^动作\s*\d/ }).click();
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '动作包 EX_HAPPY', exact: true })).toContainText('3 个动作文件');
    await expect(page.getByRole('button', { name: /^动作\s*1$/ })).toBeVisible();
    await shot('prism-motion-packages.png');
    await page.getByRole('textbox', { name: '语义搜索' }).fill('EX_HAPPY');
    await page.getByRole('textbox', { name: '语义搜索' }).press('Enter');
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await page.getByRole('button', { name: '动作包 EX_HAPPY', exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await expect(page.getByLabel('当前位置')).toContainText('动作');
    await expect(page.locator('.library-heading h1')).toContainText('EX_HAPPY');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('button', { name: '动作包 EX_HAPPY', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '语义搜索' })).toHaveValue('EX_HAPPY');
    await page.getByRole('button', { name: '前进', exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByRole('button', { name: '返回动作包', exact: true }).click();
    await page.getByRole('button', { name: '动作包 EX_HAPPY', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await shot('prism-motion-package-files.png');
    await page.getByRole('button', { name: '素材 motion.vmd', exact: true }).dblclick();
    await ready();
    await expect(viewer().locator('.motion-stage-label')).toContainText('50 / 50');
    await expect(viewer().getByRole('button', { name: '播放动作', exact: true })).toBeEnabled();
    await expect(viewer().getByLabel('音乐', { exact: true })).toHaveValue('');
    await expect(viewer().getByLabel('地面网格')).toBeChecked();
    await expect(viewer().getByLabel('地面阴影')).not.toBeChecked();
    await frame(150);
    await rememberCanvas();
    const motionRequestCount = assetRequests.length;
    const gridFrame = await viewer().locator('canvas').screenshot();
    await viewer().getByLabel('地面网格').uncheck();
    expect(Buffer.compare(gridFrame, await viewer().locator('canvas').screenshot())).not.toBe(0);
    const noShadow = await viewer().locator('canvas').screenshot();
    await viewer().getByLabel('地面阴影').check();
    expect(Buffer.compare(noShadow, await viewer().locator('canvas').screenshot())).not.toBe(0);
    await expect(viewer().getByRole('slider', { name: '动作时间轴' })).toHaveValue('150');
    await changeTheme('dark'); await sameCanvas();
    await expect(viewer().getByRole('slider', { name: '动作时间轴' })).toHaveValue('150');
    await changeTheme('light');
    await sameCanvas(); expect(assetRequests.length).toBe(motionRequestCount);
    await shot('prism-motion-light.png');
    const imageAt150 = await viewer().locator('canvas').screenshot();
    await frame(300);
    expect(Buffer.compare(imageAt150, await viewer().locator('canvas').screenshot())).not.toBe(0);
    await viewer().getByRole('button', { name: '下一帧', exact: true }).click();
    await expect(viewer().locator('.motion-playback output')).toContainText('第 301 /');
    await viewer().getByRole('button', { name: '上一帧', exact: true }).click();
    await expect(viewer().locator('.motion-playback output')).toContainText('第 300 /');
    await viewer().getByLabel('播放速度').selectOption('2');
    await viewer().getByRole('button', { name: '播放动作', exact: true }).click();
    await expect.poll(async () => Number(await viewer().getByRole('slider', { name: '动作时间轴' }).inputValue())).toBeGreaterThan(310);
    await viewer().getByRole('button', { name: '暂停动作', exact: true }).click();
    await frame(499); await viewer().getByLabel('循环', { exact: true }).uncheck();
    await viewer().getByRole('button', { name: '播放动作', exact: true }).click();
    await expect(viewer().getByRole('button', { name: '播放动作', exact: true })).toBeVisible();
    await expect(viewer().locator('.motion-playback output')).toContainText('第 500 /');
    await viewer().getByLabel('循环', { exact: true }).check(); await frame(499);
    await viewer().getByRole('button', { name: '播放动作', exact: true }).click();
    await expect.poll(async () => Number(await viewer().getByRole('slider', { name: '动作时间轴' }).inputValue())).toBeLessThan(100);
    await viewer().getByRole('button', { name: '暂停动作', exact: true }).click();
    await viewer().getByLabel('骨架叠加').check(); await frame(150); await shot('prism-motion-skeleton.png');
    await viewer().getByLabel('骨架叠加').uncheck();
    const facial = await viewer().getByLabel('追加表情').locator('option').last().getAttribute('value');
    await viewer().getByLabel('追加表情').selectOption(facial); await ready();
    await expect(viewer().locator('.motion-stage-label')).toContainText('51 / 51');
    await viewer().getByLabel('使用原始镜头').check(); await frame(180);
    await expect(viewer().locator('.motion-stage-label')).toContainText('原始镜头');
    await shot('prism-motion-original-camera.png');
    await viewer().getByLabel('使用原始镜头').uncheck();
    const music = await viewer().getByLabel('音乐', { exact: true }).locator('option').last().getAttribute('value');
    await page.evaluate(() => {
      window.__audioPlays = 0;
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) { window.__audioPlays++; return play.apply(this, args); };
    });
    await viewer().getByLabel('音乐', { exact: true }).selectOption(music);
    await viewer().getByRole('button', { name: '播放动作', exact: true }).click();
    await expect.poll(async () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCurrentlyAudible()), { timeout: 10000 }).toBe(true);
    const audioPlays = await page.evaluate(() => window.__audioPlays);
    const playingFrame = Number(await viewer().getByRole('slider', { name: '动作时间轴' }).inputValue());
    await viewer().getByLabel('地面网格').check();
    await viewer().getByLabel('地面阴影').uncheck();
    await expect.poll(async () => Number(await viewer().getByRole('slider', { name: '动作时间轴' }).inputValue())).toBeGreaterThan(playingFrame);
    expect(await page.evaluate(() => window.__audioPlays)).toBe(audioPlays);
    await viewer().getByLabel('地面网格').uncheck();
    await viewer().getByLabel('地面阴影').check();
    await viewer().getByRole('button', { name: '暂停动作', exact: true }).click();
    await viewer().getByLabel('音乐', { exact: true }).selectOption('');
    await expect(viewer().locator('.asset-error')).toHaveCount(0);
    await viewer().getByRole('button', { name: 'readme_tencha.txt', exact: true }).click();
    await expect(viewer().getByRole('dialog', { name: '动作使用说明' })).toContainText('tencha');
    await viewer().getByRole('button', { name: '关闭说明', exact: true }).click();
    const modelOptions = await viewer().getByLabel('预览角色').locator('option').evaluateAll(options => options.map(o => o.value));
    for (const id of modelOptions) {
      await viewer().getByLabel('预览角色').selectOption(id); await ready(); await frame(150);
      await expect(viewer().locator('.motion-stage-label')).toContainText('51 / 51');
      if (id === 'builtin-prism-mannequin') continue;
      await expect(viewer().getByLabel('头发与衣裙物理')).toBeChecked();
      await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-physics', 'ready', { timeout: 30000 });
      await rememberCanvas();
      const physicsRequestCount = assetRequests.length;
      const withPhysics = await viewer().locator('canvas').screenshot();
      await frame(300); await frame(0); await frame(150);
      await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-physics', 'ready', { timeout: 30000 });
      await expect.poll(async () => pixelDifference(withPhysics, await viewer().locator('canvas').screenshot())).toBeLessThan(.001);
      await shot(`prism-motion-physics-on-${id}.png`);
      await viewer().getByLabel('头发与衣裙物理').uncheck();
      await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-physics', 'off');
      await sameCanvas();
      await expect(viewer().getByRole('slider', { name: '动作时间轴' })).toHaveValue('150');
      expect(pixelDifference(withPhysics, await viewer().locator('canvas').screenshot())).toBeGreaterThan(.001);
      await shot(`prism-motion-physics-off-${id}.png`);
      expect(await page.evaluate(() => window.__physicsWorkers.size)).toBe(0);
      await viewer().getByLabel('头发与衣裙物理').check();
      await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-physics', 'ready', { timeout: 30000 });
      await expect.poll(async () => pixelDifference(withPhysics, await viewer().locator('canvas').screenshot())).toBeLessThan(.001);
      await sameCanvas(); expect(assetRequests.length).toBe(physicsRequestCount);
      expect(await page.evaluate(() => window.__physicsWorkers.size)).toBe(1);
      console.log('PHYSICS_UI_OK', id, 'pose changes, deterministic seek/restart, canvas/time retained');
    }
    // Failed initialization must stay playable, and switching off/on must recover without reloading the model.
    await viewer().getByLabel('头发与衣裙物理').uncheck();
    await page.evaluate(() => { window.__failPhysicsWorker = true; });
    await viewer().getByLabel('头发与衣裙物理').check();
    await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-physics', 'error');
    await expect(viewer().locator('.motion-physics-note')).toContainText('已回退到普通动作');
    await frame(180);
    await page.evaluate(() => { window.__failPhysicsWorker = false; });
    await viewer().getByLabel('头发与衣裙物理').uncheck();
    await viewer().getByLabel('头发与衣裙物理').check();
    await frame(450); await frame(120);
    await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-physics', 'ready', { timeout: 30000 });
    await expect(viewer().getByRole('slider', { name: '动作时间轴' })).toHaveValue('120');
    await viewer().getByLabel('音乐', { exact: true }).selectOption(music);
    await viewer().getByRole('button', { name: '播放动作', exact: true }).click();
    await expect.poll(async () => Number(await viewer().getByRole('slider', { name: '动作时间轴' }).inputValue())).toBeGreaterThan(130);
    await expect.poll(async () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCurrentlyAudible())).toBe(true);
    await viewer().getByRole('button', { name: '暂停动作', exact: true }).click();
    await viewer().getByLabel('音乐', { exact: true }).selectOption('');
    await frame(499);
    await viewer().getByRole('button', { name: '播放动作', exact: true }).click();
    await expect.poll(async () => Number(await viewer().getByRole('slider', { name: '动作时间轴' }).inputValue()), { timeout: 30000 }).toBeLessThan(100);
    await viewer().getByRole('button', { name: '暂停动作', exact: true }).click();
    // Cancel fresh computation during a model switch and while closing.
    await viewer().getByLabel('预览角色').selectOption(modelOptions[1]); await ready(); await frame(450);
    await viewer().getByLabel('预览角色').selectOption(modelOptions.at(-1)); await ready(); await frame(450);
    await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0);
    expect(await page.evaluate(() => window.__physicsWorkers.size)).toBe(0);
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.locator('.inspector-preview').click(); await ready(); await frame(120);
    await expect(viewer().locator('.motion-stage')).toHaveAttribute('data-physics', 'ready', { timeout: 30000 });
    await expect(viewer().getByLabel('预览角色')).toHaveValue(modelOptions.at(-1));
    await shot('prism-motion-dark.png');
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
    await expect(viewer().getByRole('button', { name: '播放动作', exact: true })).toBeInViewport();
    const footerY = (await viewer().locator('footer').boundingBox()).y;
    await viewer().locator('.motion-options').evaluate(el => el.scrollTop = el.scrollHeight);
    expect((await viewer().locator('footer').boundingBox()).y).toBe(footerY);
    await shot('prism-motion-small.png');
    await viewer().getByRole('button', { name: '关闭动作预览', exact: true }).click();
    await expect(page.locator('.motion-stage canvas')).toHaveCount(0);
    expect(await page.evaluate(() => window.__physicsWorkers.size)).toBe(0);
    await page.getByLabel('文字搜索方式').selectOption('keyword');
    await page.getByRole('textbox', { name: '语义搜索' }).fill('motion');
    await page.getByRole('textbox', { name: '语义搜索' }).press('Enter');
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await page.getByRole('button', { name: '退出搜索', exact: true }).click();
    await openModel();
    await expect(modelViewer().getByLabel('地面网格')).not.toBeChecked();
    await expect(modelViewer().getByLabel('地面阴影')).toBeChecked();
    await expect(modelViewer().getByRole('button', { name: '复位视角' })).toBeInViewport();
    await shot('prism-shared-model-small.png');
    await page.keyboard.press('Escape');
    await expect(page.locator('.preview-canvas canvas')).toHaveCount(0);
    expect(errors).toEqual([]);
    console.log('MOTION_UI_OK: local WASM physics on 3 PMX, visible pose changes, deterministic seek/restart, retained canvas/time/assets, failure fallback/recovery, audio/loop/cancel/worker cleanup; shared stage, packages, built-in, playback, facial/camera/docs, themes/minimum size; artifacts', output);
  } catch (error) {
    if (page && !page.isClosed()) {
      await shot('prism-motion-failure.png').catch(() => {});
      console.error((await page.locator('body').innerText()).slice(-6000));
    }
    console.error('MOTION_UI artifacts', output, 'test library', temp); throw error;
  } finally { if (instance) await instance.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
