// Real Electron clicks with an isolated library; failures occur before embedding.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-retry-ui-'));
const fixtures = path.join(temp, 'fixtures');
fs.mkdirSync(fixtures);
fs.writeFileSync(path.join(fixtures, 'wrapped.glb'), Buffer.concat([Buffer.from('CTV1'), Buffer.alloc(100)]));
fs.writeFileSync(path.join(fixtures, 'broken.png'), 'not an image');
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: path.join(temp, 'library') };
for (const name of ['ELECTRON_RUN_AS_NODE', 'PRISM_DEV_URL', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) delete env[name];
let instance;
(async () => {
  try {
    instance = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
    const page = await instance.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await instance.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    });
    await expect(page.getByRole('button', { name: /关联素材文件夹/ }).first()).toBeVisible({ timeout: 60000 });
    await instance.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    }, fixtures);
    await page.getByRole('button', { name: /关联素材文件夹/ }).first().click();
    await page.getByRole('button', { name: '关闭任务' }).click();
    await page.getByRole('button', { name: '2 个文件索引失败', exact: true }).click({ timeout: 30000 });
    await page.getByRole('button', { name: '素材 wrapped.glb', exact: true }).click();
    await expect(page.locator('.inspector .asset-error')).toContainText('CTV1');
    await page.getByRole('button', { name: '重试索引', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('已安排 1 项重试');
    await expect(page.getByRole('button', { name: '关闭任务' })).toBeVisible();
    await expect.poll(async () => {
      const summary = await page.evaluate(() => window.prism.api('/summary'));
      return summary.jobs[0].name.startsWith('重试：') && summary.jobs[0].done === 1 && summary.jobs[0].failed === 1;
    }).toBe(true);
    await page.getByRole('button', { name: '关闭任务' }).click();
    await expect(page.getByRole('button', { name: '重试索引', exact: true })).toBeEnabled();
    await expect(page.locator('.asset-card')).toHaveCount(2);

    await page.getByRole('button', { name: '多选', exact: true }).click();
    await page.getByRole('button', { name: '全选已显示项', exact: true }).click();
    await page.getByRole('button', { name: '重试选中失败项', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('已安排 2 项重试');
    await expect.poll(async () => {
      const summary = await page.evaluate(() => window.prism.api('/summary'));
      return summary.jobs[0].total === 2 && summary.jobs[0].done === 2;
    }).toBe(true);
    await page.getByRole('button', { name: '关闭任务' }).click();
    await page.getByRole('button', { name: '退出多选', exact: true }).click();
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByLabel('文件名筛选').fill('wrapped');
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await page.getByRole('button', { name: '重试当前范围', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('已安排 1 项重试');
    await expect.poll(async () => {
      const summary = await page.evaluate(() => window.prism.api('/summary'));
      return summary.jobs[0].total === 1 && summary.jobs[0].done === 1;
    }).toBe(true);
    expect(errors).toEqual([]);
    console.log('RETRY_UI_OK: real single, multiselect and filtered retry clicks; tasks, error details and state refresh');
  } finally {
    if (instance) await instance.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
