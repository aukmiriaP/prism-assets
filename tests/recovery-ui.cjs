// Real Electron interactions against a read-only-source snapshot, without copying weights.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const snapshot = process.env.PRISM_TEST_REUSE;
if (!snapshot) throw new Error('Set PRISM_TEST_REUSE to a recovery_snapshot.py output directory');
const temp = path.resolve(snapshot);
const db = path.join(temp, 'data/catalog.sqlite3');
// Reintroduce one ambiguous historical record with annotations to exercise human choice.
execFileSync(path.join(root, '.venv/bin/python'), ['-c', `
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
row=db.execute("SELECT id FROM assets WHERE archived=1 AND json_array_length(replacements)>1 LIMIT 1").fetchone()
assert row, "The snapshot must contain a shared duplicate"
db.execute("UPDATE assets SET archived=0,replacements='[]',tags='[\\"验证恢复\\"]' WHERE id=?",row)
db.commit()
`, db]);
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: path.join(temp, 'data') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'PRISM_DEV_URL', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) delete env[key];
let instance;
(async () => {
  try {
    instance = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
    const page = await instance.firstWindow();
    const capture = async name => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const data = await instance.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64');
      });
      fs.writeFileSync(path.join(temp, name), Buffer.from(data, 'base64'));
    };
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    await expect(page.locator('.asset-card')).toHaveCount(3, { timeout: 60000 });
    await expect.poll(async () => (await page.evaluate(() => window.prism.api('/summary'))).jobs.every(j => j.status === 'completed')).toBe(true);
    await page.getByRole('button', { name: /^模型附属贴图/ }).click();
    await expect(page.getByLabel('贴图展示方式')).toHaveValue('groups');
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await expect(page.locator('.result-controls')).toContainText('3 个模型分组 · 126 张附属贴图');
    await expect(page.locator('.copy-badge').first()).toContainText(/\d+ 张贴图/);
    await expect(page.locator('.asset-caption').first()).not.toContainText('undefined');
    await capture('model-groups.png');
    const groups = await page.evaluate(() => window.prism.api('/assets/resource-groups', 'POST', {}));
    const group = groups.items[0];
    await page.getByRole('button', { name: `模型分组 ${group.name}`, exact: true }).click();
    await expect(page.locator('.result-controls')).toContainText(`${group.resource_count} 个文件`);
    await expect(page.getByRole('button', { name: '返回模型分组', exact: true })).toBeVisible();
    await capture('model-group-resources.png');
    await page.getByLabel('资源类型').selectOption('bound');
    await expect(page.locator('.result-controls')).toContainText(`${group.bound_count} 个文件`);
    await page.getByLabel('资源类型').selectOption('auxiliary');
    await expect(page.locator('.result-controls')).toContainText(`${group.auxiliary_count} 个文件`);
    await page.getByRole('button', { name: '多选', exact: true }).click();
    await page.getByRole('button', { name: '全选已显示项', exact: true }).click();
    await page.getByLabel('批量标签').fill('分组验证');
    await page.getByRole('button', { name: '添加标签', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('已更新');
    await page.getByRole('button', { name: '退出多选', exact: true }).click();
    await page.locator('.asset-card').first().click();
    await expect(page.locator('.owner-links')).toContainText(group.name);
    await expect(page.locator('.asset-tags')).toContainText('分组验证');
    await page.getByRole('button', { name: '返回模型分组', exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(3);
    await page.getByLabel('贴图展示方式').selectOption('flat');
    await expect(page.locator('.result-controls')).toContainText('126 个文件');
    await expect(page.locator('.result-controls')).toContainText('96 项不同内容');
    await page.getByRole('button', { name: '1 个文件已失联', exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await page.locator('.asset-card').first().click();
    await expect(page.getByRole('button', { name: '使用此位置恢复', exact: true })).toHaveCount(3);
    await page.getByRole('button', { name: '使用此位置恢复', exact: true }).first().click();
    await expect(page.locator('.toast')).toContainText('已恢复关联');
    await expect(page.locator('.detail-status')).toContainText('已索引');
    await expect(page.locator('.asset-tags')).toContainText('验证恢复');
    await expect(page.locator('.inspector')).toContainText('历史位置');
    await expect.poll(async () => (await page.evaluate(() => window.prism.api('/summary'))).counts.missing || 0).toBe(0);
    expect(errors).toEqual([]);
    console.log('RECOVERY_UI_OK: three model groups, drilldown, bound/aux filters, bulk tags, owner links, flat fallback, ambiguous recovery and historical paths');
  } finally {
    if (instance) await instance.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
