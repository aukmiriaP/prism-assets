// Real Electron + production renderer/IPC/API/Blender, deterministic test-only vectors.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-material-ui-'));
const output = process.env.PRISM_TEST_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
const samples = path.join(root, '..', 'prism-material-samples');
const originals = path.join(temp, 'samples');
fs.cpSync(samples, originals, { recursive: true });
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: path.join(temp, 'library') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'PRISM_DEV_URL', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) delete env[key];
let instance, page;
const errors = [];
const summary = () => page.evaluate(() => window.prism.api('/summary'));
const editor = () => page.getByRole('dialog', { name: '导入 PBR 材质', exact: true });
async function settled() {
  await expect.poll(async () => (await summary()).jobs.some(j => ['queued', 'running'].includes(j.status)),
    { timeout: 180000 }).toBe(false);
}
async function choose(folder, canceled = false) {
  await instance.evaluate(({ dialog }, value) => {
    dialog.showOpenDialog = async () => ({ canceled: value.canceled, filePaths: value.folder ? [value.folder] : [] });
  }, { folder, canceled });
}
async function repeat(locator, value) {
  await locator.focus(); await locator.press('Home');
  for (let i = .25; i < value; i += .25) await locator.press('ArrowRight');
}
async function screenshot(name) {
  if (await page.getByRole('button', { name: '关闭提示', exact: true }).count())
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.waitForTimeout(180);
  const png = await instance.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus();
    return (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
}
async function previewReady(dialog) {
  await expect(dialog.getByRole('button', { name: '刷新预览', exact: true })).toBeEnabled({ timeout: 15000 });
  await expect(dialog.locator('.material-stage')).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
  await expect(dialog.locator('.material-stage-status')).toHaveCount(0, { timeout: 15000 });
}
async function launch() {
  instance = await electron.launch({ args: [path.join(root, 'tests/material-ui-main.cjs')], cwd: root, env, timeout: 60000 });
  page = await instance.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith('http://127.0.0.1:')) errors.push('external request'); });
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  await expect(page.getByRole('button', { name: /^PBR 材质/ })).toBeVisible({ timeout: 60000 });
}
async function importSample(directory, name) {
  await choose(path.join(originals, directory));
  await page.getByRole('button', { name: '导入材质包', exact: true }).click();
  await expect(editor()).toBeVisible();
  await expect(editor().getByLabel('基础色贴图')).toHaveValue(`${directory}_diff_1k.jpg`);
  await expect(editor().getByLabel('法线贴图')).toHaveValue(`${directory}_nor_gl_1k.jpg`);
  await expect(editor().getByLabel('法线约定')).toHaveValue('opengl');
  await editor().getByLabel('材质名称').fill(name);
  await previewReady(editor());
}
(async () => {
  try {
    await launch();
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('button', { name: /^PBR 材质/ }).click();
    await choose(null, true);
    await page.getByRole('button', { name: '导入材质包', exact: true }).click();
    await expect(editor()).toHaveCount(0);
    fs.mkdirSync(path.join(temp, 'empty'));
    await choose(path.join(temp, 'empty'));
    await page.getByRole('button', { name: '导入材质包', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('没有可读取');
    await importSample('wood_planks', '旧木地板');
    expect(await summary().then(s => s.materials)).toBe(0);
    const shape = editor().getByRole('button', { name: '立方体', exact: true });
    await shape.click(); await expect(shape).toHaveAttribute('aria-pressed', 'true');
    await editor().getByRole('button', { name: '平面', exact: true }).click();
    await editor().getByRole('button', { name: '材质球', exact: true }).click();
    const canvas = editor().locator('.material-canvas canvas');
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 35, { steps: 12 }); await page.mouse.up();
    await repeat(editor().getByLabel('UV 重复', { exact: true }), 2);
    await expect(editor().locator('output').nth(3)).toHaveText('2.00');
    await editor().getByRole('button', { name: '复位材质视角', exact: true }).click();
    // Fixed header/footer, inset long-list scroll at the minimum window size.
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
    const headerY = (await editor().locator('header').boundingBox()).y;
    const footerY = (await editor().locator('footer').boundingBox()).y;
    const controls = editor().locator('.material-controls');
    expect(await controls.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await controls.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect((await editor().locator('header').boundingBox()).y).toBe(headerY);
    expect((await editor().locator('footer').boundingBox()).y).toBe(footerY);
    await expect(editor().getByRole('button', { name: '导入材质', exact: true })).toBeInViewport();
    await screenshot('material-editor-small.png');
    await page.keyboard.press('Escape');
    await expect(editor()).toHaveCount(0);
    expect((await summary()).materials).toBe(0);
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
    for (const [directory, name] of [['wood_planks', '旧木地板'], ['rusty_metal_04', '锈蚀金属'], ['rock_boulder_dry', '干燥岩石']]) {
      await importSample(directory, name);
      if (directory === 'rusty_metal_04') await expect(editor().getByLabel('金属度贴图')).toHaveValue('rusty_metal_04_metal_1k.jpg');
      await editor().getByRole('button', { name: '导入材质', exact: true }).click();
      await expect(editor()).toHaveCount(0); await settled();
    }
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByRole('button', { name: '素材 旧木地板', exact: true }).click();
    await page.locator('.inspector').getByRole('button', { name: '收藏素材', exact: true }).click();
    await page.getByRole('textbox', { name: '添加标签', exact: true }).fill('环境材质');
    await page.getByRole('textbox', { name: '添加标签', exact: true }).press('Enter');
    await expect(page.locator('.asset-tags')).toContainText('环境材质');
    await page.getByRole('button', { name: '详情新建集合', exact: true }).click();
    await page.getByLabel('集合名称').fill('游戏场景');
    await page.getByRole('button', { name: '创建集合', exact: true }).click();
    await page.getByRole('button', { name: '加入当前素材', exact: true }).click();
    await expect(page.locator('.collection-chips')).toContainText('游戏场景');
    await page.getByRole('button', { name: '编辑通道与表面参数', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑 PBR 材质', exact: true });
    await expect(edit).toBeVisible();
    await edit.getByLabel('材质名称').fill('木地板修订');
    await edit.getByLabel('粗糙度贴图').selectOption('wood_planks_ao_1k.jpg');
    await edit.getByLabel('粗糙度通道').selectOption('g');
    await edit.getByLabel('粗糙度反相').check();
    await edit.getByLabel('法线约定').selectOption('directx');
    await repeat(edit.getByLabel('UV 重复', { exact: true }), 2);
    await previewReady(edit);
    await screenshot('material-editor-dark.png');
    await edit.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(edit).toHaveCount(0); await settled();
    await expect(page.locator('.inspector>h2')).toHaveText('木地板修订');
    await expect(page.locator('.asset-tags')).toContainText('环境材质');
    await expect(page.locator('.inspector').getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
    await expect(page.locator('.collection-chips')).toContainText('游戏场景');
    const material = await page.evaluate(async () => (await window.prism.api('/assets/list', 'POST', { kind: 'material', name: '木地板修订' })).items[0]);
    expect(material.material.config.maps.roughness.channel).toBe('g');
    expect(material.material.config.maps.roughness.invert).toBe(true);
    expect(material.material.config.normal_format).toBe('directx');
    const exportPath = path.join(output, 'wood-floor.prism-pbr.zip');
    await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportPath);
    await page.getByRole('button', { name: '导出 Blender 材质包', exact: true }).click();
    await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
    expect(fs.readFileSync(exportPath).subarray(0, 2).toString()).toBe('PK');
    await instance.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
    await page.getByRole('button', { name: '导出 Blender 材质包', exact: true }).click();
    await page.locator('.inspector-preview').click();
    const viewer = page.getByRole('dialog', { name: 'PBR 材质预览', exact: true });
    await expect(viewer.locator('.material-stage')).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
    await expect(viewer.locator('.material-stage-status')).toHaveCount(0, { timeout: 15000 });
    await viewer.getByRole('button', { name: '立方体', exact: true }).click();
    await screenshot('material-cube-dark.png'); await page.keyboard.press('Escape');
    await page.getByLabel('文字搜索方式').selectOption('keyword');
    await page.getByRole('textbox', { name: '语义搜索' }).fill('木地板修订');
    await page.getByRole('textbox', { name: '语义搜索' }).press('Enter');
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await page.getByRole('button', { name: '退出搜索', exact: true }).click();
    await page.getByRole('button', { name: '查找相似', exact: true }).click();
    await expect(page.locator('.score-badge')).toHaveCount(3); await page.getByRole('button', { name: '退出搜索', exact: true }).click();
    // Restore conventional maps for the final visual examples.
    await page.getByRole('button', { name: '编辑通道与表面参数', exact: true }).click();
    await edit.getByLabel('粗糙度贴图').selectOption('wood_planks_rough_1k.jpg');
    await edit.getByLabel('粗糙度通道').selectOption('r'); await edit.getByLabel('粗糙度反相').uncheck();
    await edit.getByLabel('法线约定').selectOption('opengl'); await repeat(edit.getByLabel('UV 重复', { exact: true }), 1);
    await edit.getByRole('button', { name: '保存修改', exact: true }).click(); await settled();
    await instance.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportPath);
    await page.getByRole('button', { name: '导出 Blender 材质包', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('已导出 Blender 材质包');
    for (const mode of ['浅色', '深色']) {
      await page.getByRole('button', { name: /设置与帮助/ }).click();
      await page.getByRole('button', { name: mode, exact: true }).click();
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await page.getByRole('button', { name: '关闭详情', exact: true }).click();
      await screenshot(`material-library-${mode === '浅色' ? 'light' : 'dark'}.png`);
      await page.getByRole('button', { name: '素材 锈蚀金属', exact: true }).click();
      await page.getByRole('button', { name: '编辑通道与表面参数', exact: true }).click();
      await previewReady(edit);
      await screenshot(`material-metal-editor-${mode === '浅色' ? 'light' : 'dark'}.png`);
      await edit.getByRole('button', { name: '取消', exact: true }).click();
    }
    await instance.close(); await launch();
    await page.getByRole('button', { name: /^PBR 材质/ }).click(); await settled();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByRole('button', { name: '素材 木地板修订', exact: true }).click();
    await expect(page.locator('.asset-tags')).toContainText('环境材质');
    await expect(page.locator('.collection-chips')).toContainText('游戏场景');
    await page.getByRole('button', { name: '素材 干燥岩石', exact: true }).click();
    await page.getByRole('button', { name: '移除材质定义', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByRole('button', { name: '移除材质定义', exact: true }).click();
    await page.getByRole('button', { name: '确认移除', exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(2);
    expect(fs.existsSync(path.join(originals, 'rock_boulder_dry/rock_boulder_dry_diff_1k.jpg'))).toBe(true);
    expect(errors).toEqual([]);
    console.log(`MATERIAL_UI_OK: native chooser/cancel/errors, real channel dropdowns, GL/DX/scalars, geometry/rotation, small inset scrolling, import/edit/metadata/search/export/restart/delete, real Blender covers and light/dark screenshots: ${output}`);
  } catch (error) {
    if (page && !page.isClosed()) await screenshot('material-failure.png').catch(() => {});
    console.error(`Material UI artifacts: ${output}; test data: ${temp}`); throw error;
  } finally {
    if (instance) await instance.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
