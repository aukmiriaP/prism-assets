const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-ui-'));
const fixture = path.join(temp, '素材测试');
const output = process.env.PRISM_TEST_OUTPUT || path.join(os.tmpdir(), 'prism-v02-ui-verification');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(fixture);
execFileSync(path.join(root, '.venv/bin/python'), ['-c',
  `import sys; sys.path.insert(0, 'tests'); from integration import draw; from pathlib import Path; p=Path(sys.argv[1]); draw(p/'红圆.png','red','circle'); draw(p/'蓝方.jpg','blue','square'); draw(p/'绿三角.webp','green','triangle')`, fixture], { cwd: root });
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: path.join(temp, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'PRISM_MODEL_DIR']) delete env[key];
if (process.env.PRISM_TEST_APP) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
let instance;
const errors = [];
async function launch() {
  instance = await electron.launch({ args: process.env.PRISM_TEST_APP ? [] : [root],
    executablePath: process.env.PRISM_TEST_APP || undefined, env, cwd: temp, timeout: 90000 });
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  // Chromium's CDP screenshot occasionally stalls on macOS occluded windows.
  page.screenshot = async ({ path: target }) => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const data = await instance.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show(); window.focus();
      return (await window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true })).toPNG().toString('base64');
    });
    fs.writeFileSync(target, Buffer.from(data, 'base64'));
  };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) errors.push('External request: ' + request.url()); });
  await expect(page.getByRole('button', { name: /关联素材文件夹/ }).first()).toBeVisible({ timeout: 90000 });
  return page;
}
(async () => {
  try {
    let page = await launch();
    await expect(page.getByText('让灵感，有迹可循。')).toBeVisible();
    await page.screenshot({ path: path.join(output, '01-empty.png') });
    await instance.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    }, fixture);
    await page.getByRole('button', { name: /关联素材文件夹/ }).first().click();
    await page.getByRole('button', { name: '关闭任务' }).click();
    await expect(page.getByRole('button', { name: '素材 红圆.png', exact: true })).toBeVisible({ timeout: 120000 });
    await expect(page.locator('.footer')).toContainText('3 个已索引', { timeout: 120000 });
    await page.getByRole('button', { name: '素材 红圆.png', exact: true }).click();
    await page.getByRole('textbox', { name: '添加标签' }).fill('形状参考');
    await page.getByRole('textbox', { name: '添加标签' }).press('Enter');
    await expect(page.locator('.asset-tags')).toContainText('形状参考');
    await page.locator('.inspector').getByRole('button', { name: '收藏素材', exact: true }).click();
    await expect(page.locator('.inspector').getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '复制路径' }).click();
    const copied = await instance.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toBe(fs.realpathSync(path.join(fixture, '红圆.png')));
    await page.screenshot({ path: path.join(output, '02-library.png') });
    await page.getByRole('textbox', { name: '语义搜索' }).fill('白色背景上的红色圆形');
    await page.getByRole('textbox', { name: '语义搜索' }).press('Enter');
    await expect(page.locator('.query-chip')).toContainText('白色背景上的红色圆形');
    await expect(page.locator('.score-badge').first()).toBeVisible({ timeout: 120000 });
    await expect(page.getByLabel('候选上限')).toHaveValue('50');
    await page.getByLabel('候选上限').selectOption('20');
    await expect(page.locator('.result-controls')).toContainText('检索范围 3 个文件');
    await expect(page.locator('.library-heading')).toContainText('搜索候选');
    await expect(page.locator('.asset-card').first()).toHaveAttribute('aria-label', '素材 红圆.png');
    await page.screenshot({ path: path.join(output, '03-search.png') });
    await page.getByRole('button', { name: '退出搜索' }).click();
    await instance.evaluate(({ dialog }, reference) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [reference] });
    }, path.join(fixture, '蓝方.jpg'));
    await page.getByRole('button', { name: '以图搜图', exact: true }).click();
    await expect(page.locator('.query-chip')).toContainText('蓝方.jpg');
    await expect(page.locator('.asset-card').first()).toHaveAttribute('aria-label', '素材 蓝方.jpg', { timeout: 120000 });
    await page.getByRole('button', { name: '素材 蓝方.jpg', exact: true }).dblclick();
    await expect(page.getByRole('dialog', { name: '大图预览' })).toBeVisible();
    await expect.poll(() => page.locator('.lightbox img').evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '退出搜索' }).click();
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByLabel('格式筛选').selectOption('jpg');
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await expect(page.locator('.asset-card')).toHaveAttribute('aria-label', '素材 蓝方.jpg');
    await page.getByRole('button', { name: '重置筛选' }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    const blueThumb = page.getByRole('button', { name: '素材 蓝方.jpg', exact: true }).locator('img');
    const previousThumb = await blueThumb.getAttribute('src');
    execFileSync(path.join(root, '.venv/bin/python'), ['-c',
      `import sys; sys.path.insert(0, 'tests'); from integration import draw; from pathlib import Path; draw(Path(sys.argv[1]), 'purple', 'circle')`,
      path.join(fixture, '蓝方.jpg')], { cwd: root });
    await expect(blueThumb).not.toHaveAttribute('src', previousThumb, { timeout: 90000 });
    await expect.poll(() => blueThumb.evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await expect(page.getByRole('dialog', { name: '设置与帮助' })).toBeVisible();
    await page.getByRole('button', { name: '关闭设置' }).click();
    // A copied file is one visual result, with explicit physical membership.
    fs.mkdirSync(path.join(fixture, 'copies'));
    fs.copyFileSync(path.join(fixture, '红圆.png'), path.join(fixture, 'copies', '红圆副本.png'));
    await expect(page.locator('.footer')).toContainText('4 个已索引', { timeout: 90000 });
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await expect(page.locator('.copy-badge')).toContainText('2 份相同文件');
    await page.getByLabel('聚合完全重复项').uncheck();
    await expect(page.locator('.asset-card')).toHaveCount(4);
    await page.getByLabel('聚合完全重复项').check();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.locator('.asset-card').filter({ has: page.locator('.copy-badge') }).click();
    await page.getByRole('button', { name: '查看全部未排除副本' }).click();
    await expect(page.locator('.copy-list>div')).toHaveCount(2);
    await page.getByRole('button', { name: '关闭详情' }).click();
    // Create a virtual collection; batch-add selected physical files with additive tags.
    await page.getByRole('button', { name: '新建集合', exact: true }).click();
    await page.getByLabel('集合名称').fill('场景参考');
    await page.getByRole('button', { name: '创建集合', exact: true }).click();
    await expect(page.locator('.collection-nav')).toContainText('场景参考');
    await page.getByRole('button', { name: /^全部素材/ }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByRole('button', { name: '多选', exact: true }).click();
    const selectionBoxes = page.locator('.selection-check');
    await selectionBoxes.nth(0).check();
    await selectionBoxes.nth(1).check();
    await expect(page.locator('.bulk-selection')).toContainText('已选 2 项');
    await page.getByRole('button', { name: '全选已显示项' }).click();
    await expect(page.locator('.bulk-selection')).toContainText('已选 3 项 · 4 个文件');
    await page.getByLabel('批量标签').fill('批量参考');
    await page.getByRole('button', { name: '添加标签', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('已更新 4 个文件');
    await page.getByRole('button', { name: '全选已显示项' }).click();
    await page.getByLabel('目标集合').selectOption({ label: '场景参考' });
    await page.getByRole('button', { name: '加入集合', exact: true }).click();
    await expect(page.locator('.collection-nav')).toContainText('4');
    await page.getByRole('button', { name: '退出多选', exact: true }).click();
    await page.locator('.collection-nav button').filter({ hasText: '场景参考' }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByRole('button', { name: '管理集合', exact: true }).click();
    await page.getByLabel('集合名称').fill('项目参考');
    await page.getByRole('button', { name: '保存集合', exact: true }).click();
    await expect(page.locator('.collection-nav')).toContainText('项目参考');
    // Directory exclusions are previewable, reversible and survive filesystem changes.
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('tab', { name: '关联目录', exact: true }).click();
    await page.getByRole('button', { name: '排除子目录 素材测试' }).click();
    await page.getByLabel('排除规则').fill('copies');
    await page.getByRole('button', { name: '预览影响' }).click();
    await expect(page.locator('.impact')).toContainText('新增 1 个');
    await page.getByRole('button', { name: '保存排除规则' }).click();
    await expect(page.locator('.folder-setting')).toContainText('已排除 1 个');
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(page.locator('.footer')).toContainText('3 个已索引');
    await page.screenshot({ path: path.join(output, '04-organized.png') });
    await instance.close();
    page = await launch();
    await expect(page.locator('.collection-nav')).toContainText('项目参考');
    await expect(page.locator('.footer')).toContainText('3 个已索引');
    await page.getByRole('button', { name: /我的收藏/ }).click();
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '素材 红圆.png', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '素材 红圆.png', exact: true }).click();
    await expect(page.locator('.asset-tags')).toContainText('形状参考');
    await expect(page.locator('.asset-tags')).toContainText('批量参考');
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('tab', { name: '关联目录', exact: true }).click();
    await page.getByRole('button', { name: '排除子目录 素材测试' }).click();
    await page.getByLabel('排除规则').fill('');
    await page.getByRole('button', { name: '预览影响' }).click();
    await expect(page.locator('.impact')).toContainText('恢复 1 个');
    await page.getByRole('button', { name: '保存排除规则' }).click();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(page.locator('.footer')).toContainText('4 个已索引');
    await page.locator('.collection-nav button').filter({ hasText: '项目参考' }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByRole('button', { name: '多选', exact: true }).click();
    await page.getByRole('button', { name: '全选已显示项' }).click();
    await page.getByRole('button', { name: '移出当前集合' }).click();
    await expect(page.locator('.asset-card')).toHaveCount(0);
    await page.getByRole('button', { name: '退出多选', exact: true }).click();
    await page.getByRole('button', { name: '管理集合', exact: true }).click();
    await page.getByRole('button', { name: '删除集合', exact: true }).click();
    await page.getByRole('button', { name: '确认删除集合', exact: true }).click();
    await expect(page.locator('.collection-nav')).not.toContainText('项目参考');
    expect(fs.existsSync(path.join(fixture, '红圆.png'))).toBe(true);
    expect(fs.existsSync(path.join(fixture, 'copies', '红圆副本.png'))).toBe(true);
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ ok: true, packaged: Boolean(process.env.PRISM_TEST_APP),
      checks: ['empty state', 'native folder selection', 'real indexing', 'tags/favorites', 'clipboard',
        'text search', 'image search', 'preview', 'format filter', 'watcher thumbnail refresh', 'settings', 'restart persistence',
        'Top-K and scope counts', 'exact duplicate grouping', 'copy paths', 'multi-selection',
        'additive batch tags', 'collection create/rename/add/remove/delete', 'exclusion preview/restore',
        'organization restart persistence', 'originals preserved',
        'zero renderer errors', 'zero external requests'], screenshots: output }, null, 2));
  } catch (error) {
    if (instance) {
      const page = await instance.firstWindow().catch(() => null);
      if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    console.error(error);
    console.error('Test data retained at', temp);
    process.exitCode = 1;
  } finally {
    if (instance) await instance.close().catch(() => {});
    if (!process.exitCode) fs.rmSync(temp, { recursive: true, force: true });
  }
})();
