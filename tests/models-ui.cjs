const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temp = process.env.PRISM_TEST_REUSE || fs.mkdtempSync(path.join(os.tmpdir(), 'prism-model-ui-'));
const output = process.env.PRISM_TEST_OUTPUT || '/tmp/prism-v03-model-ui';
fs.mkdirSync(output, { recursive: true });
const dataset = path.resolve(root, '../datasets/character_model');
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: path.join(temp, 'data') };
if (process.env.PRISM_TEST_REBUILD_MODELS && process.env.PRISM_TEST_REUSE) {
  require('node:child_process').execFileSync(path.join(root, '.venv/bin/python'), ['-c',
    `import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE assets SET status='pending' WHERE kind='model'"); db.commit()`,
    path.join(temp, 'data/catalog.sqlite3')]);
}
delete env.ELECTRON_RUN_AS_NODE;
for (const key of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'PRISM_MODEL_DIR']) delete env[key];
let instance, page;
const errors = [];
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const data = await instance.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show(); window.focus();
    return (await window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true })).toPNG().toString('base64');
  });
  const buffer = Buffer.from(data, 'base64');
  if (name) fs.writeFileSync(path.join(output, name), buffer);
  return buffer;
}
(async () => {
  try {
    instance = await electron.launch({ args: process.env.PRISM_TEST_APP ? [] : [root],
      executablePath: process.env.PRISM_TEST_APP || undefined, env, cwd: temp, timeout: 90000 });
    page = await instance.firstWindow();
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith('http://127.0.0.1:')) errors.push('External request'); });
    await expect(page.getByRole('button', { name: /关联素材文件夹/ }).first()).toBeVisible({ timeout: 90000 });
    await instance.evaluate(({ dialog }, dataset) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dataset] });
    }, dataset);
    await page.getByRole('button', { name: /关联素材文件夹/ }).first().click();
    await page.getByRole('button', { name: '关闭任务' }).click();
    await expect(page.locator('.footer')).toContainText('129 个已索引', { timeout: 450000 });
    console.log('REAL_INDEX_READY', temp);
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.bringToFront();
    await capture('01-model-cards.png');
    const card = page.getByRole('button', { name: '素材 鸣潮_锁暝1.0.pmx', exact: true });
    await card.click();
    await expect(page.locator('.model-metrics')).toContainText('22');
    await page.locator('.material-list summary').first().click();
    await expect(page.locator('.material-binding').first()).toBeVisible();
    await page.getByRole('button', { name: '已引用', exact: true }).click();
    await expect(page.locator('.resource-row')).toHaveCount(22);
    await page.locator('.resource-thumb').first().click();
    await expect(page.getByRole('dialog', { name: '贴图资源预览' })).toBeVisible();
    await expect.poll(() => page.locator('.resource-modal img').evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
    await page.getByRole('button', { name: '关闭贴图' }).click();
    await expect(page.getByRole('dialog', { name: '贴图资源预览' })).toHaveCount(0);
    await capture('02-material-resources.png');
    await card.dblclick();
    await expect(page.getByRole('dialog', { name: '3D 模型预览' })).toBeVisible();
    await expect(page.locator('.model-loading')).toHaveCount(0, { timeout: 60000 });
    const canvas = page.locator('.model-canvas canvas');
    await expect(canvas).toBeVisible();
    const before = await capture('03-interactive-model.png');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .5);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .75, box.y + box.height * .5, { steps: 15 }); await page.mouse.up();
    const after = await capture();
    expect(Buffer.compare(before, after)).not.toBe(0);
    await page.getByLabel('线框', { exact: true }).check();
    await expect(page.getByLabel('线框', { exact: true })).toBeChecked();
    await page.getByLabel('隔离材质').selectOption({ index: 1 });
    await capture('04-wireframe-isolation.png');
    await page.getByRole('button', { name: '复位视角' }).click();
    await expect(page.getByLabel('隔离材质')).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '3D 模型预览' })).toHaveCount(0);
    await card.click();
    await page.getByRole('button', { name: '查找相似', exact: true }).click();
    await expect(page.locator('.score-badge')).toHaveCount(3, { timeout: 30000 });
    await expect(page.locator('.asset-card').first()).toHaveAttribute('aria-label', '素材 鸣潮_锁暝1.0.pmx');
    await page.getByRole('button', { name: '退出搜索', exact: true }).click();
    await page.getByLabel('文字搜索方式').selectOption('semantic');
    await page.getByRole('textbox', { name: '语义搜索' }).fill('黑色裙子，红色长发的女孩');
    await page.getByRole('textbox', { name: '语义搜索' }).press('Enter');
    await expect(page.locator('.score-badge')).toHaveCount(3, { timeout: 60000 });
    await expect(page.locator('.score-badge').first()).not.toHaveText('1.000', { timeout: 60000 });
    console.log('TEXT_CANDIDATES', await page.locator('.asset-card').evaluateAll(els => els.map(el => ({ name: el.getAttribute('aria-label'), score: el.querySelector('.score-badge')?.textContent }))));
    await page.getByRole('button', { name: '退出搜索', exact: true }).click();
    await page.getByRole('button', { name: /^3D 模型/ }).click();
    await page.getByRole('button', { name: '模型分组 鸣潮_锁暝1.0.pmx', exact: true }).click();
    await page.getByLabel('资源类型', { exact: true }).selectOption('bound');
    await expect(page.locator('.result-controls')).toContainText('当前范围 22 个文件');
    await page.locator('.asset-card').first().click();
    await expect(page.locator('.owner-links')).toBeVisible();
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ ok: true, temp, output, checks: [
      'three real PMXs / 126 textures / 129 real embeddings', 'three parent cards', 'material and resource bindings',
      'texture preview', 'GLB loading', 'actual drag changes render', 'wireframe and material isolation',
      'reset and Escape', 'model similar search', 'Chinese text search', 'model group and bound-texture owner navigation',
      'zero renderer exceptions and external requests'] }, null, 2));
  } catch (e) {
    console.error(e); console.error({ errors, temp }); process.exitCode = 1;
    if (page) console.error(await page.locator('.model-loading,.toast,.asset-error').allTextContents().catch(() => []));
  } finally {
    if (instance) await instance.close().catch(() => {});
  }
})();
