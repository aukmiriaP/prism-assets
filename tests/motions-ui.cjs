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
const viewer = () => page.getByRole('dialog', { name: '人形动作预览', exact: true });
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
async function launch() {
  instance = await electron.launch({ args: [path.join(root, 'tests/material-ui-main.cjs')], cwd: root, env, timeout: 60000 });
  page = await instance.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) errors.push('external request'); });
  await instance.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.setSize(1440, 940); win.webContents.setBackgroundThrottling(false);
  });
  await expect(page.getByRole('button', { name: /^动作\s*\d/ })).toBeVisible({ timeout: 60000 });
}
(async () => {
  try {
    await launch();
    await page.evaluate(async source => window.prism.api('/folders', 'POST', { path: source }), path.join(root, '../datasets/motion'));
    await expect.poll(async () => page.evaluate(async () => (await window.prism.api('/summary')).motions), { timeout: 60000 }).toBe(3);
    await page.getByRole('button', { name: /^动作\s*\d/ }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByRole('button', { name: '素材 motion.vmd', exact: true }).dblclick();
    await ready();
    await expect(viewer().locator('.motion-stage-label')).toContainText('50 / 50');
    await expect(viewer().getByRole('button', { name: '播放动作', exact: true })).toBeEnabled();
    await expect(viewer().getByLabel('音乐', { exact: true })).toHaveValue('');
    await frame(150);
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
    await viewer().getByLabel('音乐', { exact: true }).selectOption(music);
    await viewer().getByRole('button', { name: '播放动作', exact: true }).click();
    await expect.poll(async () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCurrentlyAudible()), { timeout: 10000 }).toBe(true);
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
    }
    await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0);
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.locator('.inspector-preview').click(); await ready(); await frame(120);
    await shot('prism-motion-dark.png');
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
    await expect(viewer().getByRole('button', { name: '播放动作', exact: true })).toBeInViewport();
    const footerY = (await viewer().locator('footer').boundingBox()).y;
    await viewer().locator('.motion-options').evaluate(el => el.scrollTop = el.scrollHeight);
    expect((await viewer().locator('footer').boundingBox()).y).toBe(footerY);
    await shot('prism-motion-small.png');
    await viewer().getByRole('button', { name: '关闭动作预览', exact: true }).click();
    await expect(page.locator('.motion-stage canvas')).toHaveCount(0);
    await page.getByLabel('文字搜索方式').selectOption('keyword');
    await page.getByRole('textbox', { name: '语义搜索' }).fill('motion');
    await page.getByRole('textbox', { name: '语义搜索' }).press('Enter');
    await expect(page.locator('.asset-card')).toHaveCount(1);
    expect(errors).toEqual([]);
    console.log('MOTION_UI_OK: real skinned PMX, 3 characters, playback/step/loop/rate, facial/camera/audio/docs, themes/minimum size, cleanup; artifacts', output);
  } catch (error) {
    if (page && !page.isClosed()) {
      await shot('prism-motion-failure.png').catch(() => {});
      console.error((await page.locator('body').innerText()).slice(-6000));
    }
    console.error('MOTION_UI artifacts', output, 'test library', temp); throw error;
  } finally { if (instance) await instance.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
