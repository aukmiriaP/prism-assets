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
fs.mkdirSync(path.join(fixtures, '忽略的子目录'));
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
    const taskToggle = page.locator('.task-toggle');
    const taskPanel = page.getByRole('region', { name: '索引任务', exact: true });
    await expect(page.getByRole('button', { name: /本地运行/ })).toHaveCount(0);
    await page.getByRole('status', { name: '本地运行', exact: true }).click();
    await expect(taskPanel).toHaveCount(0);
    await taskToggle.click();
    await expect(taskPanel).toBeVisible();
    await expect(taskToggle).toHaveAttribute('aria-expanded', 'true');
    await taskPanel.getByText('暂无索引任务').click();
    await expect(taskPanel).toBeVisible();
    await taskToggle.click();
    await expect(taskPanel).toHaveCount(0);
    await expect(taskToggle).toHaveAttribute('aria-expanded', 'false');
    await taskToggle.click(); await page.keyboard.press('Escape');
    await expect(taskPanel).toHaveCount(0);
    await instance.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    }, fixtures);
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('tab', { name: '关联目录', exact: true }).click();
    await expect(page.locator('.settings-empty')).toBeVisible();
    await page.getByRole('button', { name: '关联文件夹', exact: true }).click();
    await expect(page.locator('.folder-setting')).toContainText('fixtures');
    await expect(taskPanel).toBeVisible();
    await page.getByRole('button', { name: '排除子目录 fixtures', exact: true }).click();
    await page.getByRole('checkbox', { name: '排除文件夹 忽略的子目录', exact: true }).check();
    await page.getByRole('button', { name: '预览影响', exact: true }).click();
    await expect(page.locator('.impact')).toContainText('新增 0 个');
    await page.getByRole('button', { name: '保存排除规则', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '目录排除', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '关联目录', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByTitle('关闭设置', { exact: true }).click();
    await taskToggle.click();
    await expect(taskPanel).toBeVisible();
    await page.locator('.gallery').click({ position: { x: 10, y: 10 } });
    await expect(taskPanel).toHaveCount(0);
    await page.getByRole('button', { name: '2 个文件索引失败', exact: true }).click({ timeout: 30000 });
    await page.getByRole('button', { name: '素材 wrapped.glb', exact: true }).click();
    await expect(page.locator('.inspector .asset-error')).toContainText('CTV1');
    await taskToggle.click();
    await page.getByRole('button', { name: '素材 broken.png', exact: true }).click();
    await expect(taskPanel).toHaveCount(0);
    await expect(page.locator('.inspector>h2')).toHaveText('broken.png');
    await page.getByRole('button', { name: '素材 wrapped.glb', exact: true }).click();
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
    // Accumulate enough real failure records to exercise a scrolling task list.
    for (let i = 0; i < 5; i++) {
      const previousJob = await page.evaluate(async () => (await window.prism.api('/summary')).jobs[0].id);
      await taskPanel.getByRole('button', { name: '重试', exact: true }).first().click();
      await expect(taskPanel).toBeVisible();
      await expect.poll(async () => {
        const summary = await page.evaluate(() => window.prism.api('/summary'));
        return summary.jobs[0].id !== previousJob && summary.jobs[0].total === 2
          && summary.jobs[0].done === 2 && summary.jobs[0].failed === 2;
      }).toBe(true);
    }
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
    const headingY = (await taskPanel.locator('.panel-heading').boundingBox()).y;
    const scroller = taskPanel.locator('.task-content');
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const panelBounds = await taskPanel.boundingBox(), scrollBounds = await scroller.boundingBox();
    expect(scrollBounds.x + scrollBounds.width).toBeLessThanOrEqual(panelBounds.x + panelBounds.width - 5);
    expect(scrollBounds.y + scrollBounds.height).toBeLessThanOrEqual(panelBounds.y + panelBounds.height - 5);
    expect((await taskPanel.locator('.panel-heading').boundingBox()).y).toBe(headingY);
    await expect(page.getByRole('button', { name: '关闭任务' })).toBeVisible();
    const png = await instance.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64'));
    fs.writeFileSync(path.join(os.tmpdir(), 'prism-task-panel-fixed.png'), Buffer.from(png, 'base64'));
    await page.getByRole('button', { name: '关闭任务' }).click();
    await expect(taskPanel).toHaveCount(0);
    expect(errors).toEqual([]);
    console.log('RETRY_UI_OK: real single, multiselect, filtered and in-panel retries; one task entry, status display, toggle/Escape/outside dismissal, retained asset clicks, inset task scrolling and fixed close button');
  } finally {
    if (instance) await instance.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
