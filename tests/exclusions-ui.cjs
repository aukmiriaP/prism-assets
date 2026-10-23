// Real Electron + real filesystem/API, cached fixtures only. No embedding or Blender.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-exclusions-ui-'));
const data = path.join(temp, 'library'), originals = path.join(temp, '测试素材');
const output = process.env.PRISM_TEST_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
execFileSync(path.join(root, '.venv/bin/python'), ['-c', `
import hashlib,json,sys,time
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
from catalog import Catalog
base=Path(sys.argv[2]).resolve(); base.mkdir()
for name in ["角色/build","角色/贴图","场景/灯光","build","动作","参考图","材质","模型","空文件夹",
             "带 空格/[草稿]?"]+[f"项目-{n:02d}" for n in range(18)]:
    (base/name).mkdir(parents=True)
(base/".hidden").mkdir()
(base/"linked").symlink_to(base/"角色",target_is_directory=True)
library=Catalog(Path(sys.argv[1]),watch=False)
library.execute("INSERT INTO folders(id,path,name,status,exclusions) VALUES('fixture',?,?,'online',?)",
    (str(base),base.name,json.dumps(["build","./已移走"])))
for n,relative in enumerate(["封面.png","build/导出.png","角色/build/测试.png","角色/角色.png","场景/环境.png"]):
    aid=f"{n+1:032x}"
    image=Image.new("RGB",(128,128),"#f2f3f5")
    ImageDraw.Draw(image).ellipse((20,20,108,108),fill=["#496cb9","#a28ec9","#78a297","#ad947b","#8194ac"][n])
    original=base/relative; image.save(original); image.save(library.thumbs/f"{aid}.webp")
    stat=original.stat()
    library.execute("""INSERT INTO assets(id,folder_id,path,name,ext,size,mtime,width,height,hash,
        thumbnail,vector,tags,favorite,status,excluded,added,updated)
        VALUES(?,'fixture',?,?,'png',?,?,128,128,?,?,?,?,1,'ready',?,?,?)""",
        (aid,str(original),original.name,stat.st_size,stat.st_mtime_ns,hashlib.sha256(original.read_bytes()).hexdigest(),
        f"{aid}.webp",np.array([1,0,0],dtype=np.float32).tobytes(),json.dumps(["保留标签"]),int("build" in original.relative_to(base).parts),time.time(),time.time()))
collection=library.save_collection("测试集合")
library.bulk_update([f"{5:032x}"],{"collection_id":collection["id"]})
library.close(); library.worker.join(3); library.db.close()
`, data, originals], { cwd: root });
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: data };
for (const key of ['ELECTRON_RUN_AS_NODE', 'PRISM_DEV_URL', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) delete env[key];
let instance, page;
const errors = [];
const check = name => page.getByRole('checkbox', { name: `排除文件夹 ${name}`, exact: true });
const dialog = () => page.getByRole('dialog', { name: '目录排除', exact: true });
const summary = () => page.evaluate(() => window.prism.api('/summary'));
const rules = async () => (await summary()).folders.find(f => f.id === 'fixture').exclusions;
const openEditor = () => page.getByRole('button', { name: '排除子目录 测试素材', exact: true }).click();
const expand = name => page.getByRole('button', { name: `展开文件夹 ${name}`, exact: true }).click();
const preview = () => page.getByRole('button', { name: '预览影响', exact: true }).click();
const save = () => page.getByRole('button', { name: '保存排除规则', exact: true }).click();
async function settled() {
  await expect.poll(async () => (await summary()).jobs.some(j => ['queued', 'running'].includes(j.status))).toBe(false);
  expect((await summary()).model).toBe('unloaded');
}
async function screenshot(name) {
  await instance.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); });
  await page.waitForTimeout(150);
  const png = await instance.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
}
(async () => {
  try {
    instance = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
    page = await instance.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await instance.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
      global.__exclusionRequests = [];
      const fetch = global.fetch;
      global.fetch = (...args) => { global.__exclusionRequests.push(new URL(args[0]).pathname); return fetch(...args); };
    });
    await expect(page.locator('.asset-card')).toHaveCount(3, { timeout: 60000 }); await settled();
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('tab', { name: '关联目录', exact: true }).click();
    await instance.evaluate(() => { global.__exclusionRequests = []; });
    const jobsBefore = (await summary()).jobs.map(j => j.id);
    await openEditor();
    await expect(check('角色')).toBeVisible();
    await expect(dialog().locator('textarea')).toHaveCount(0);
    await expect(dialog()).not.toContainText('每行一个目录');
    await expect(dialog()).not.toContainText('node_modules');
    await expect(check('.hidden')).toHaveCount(0); await expect(check('linked')).toHaveCount(0);
    await expect(check('build')).toBeChecked(); await expect(check('build')).toBeDisabled();
    await expand('角色');
    await expect(check('角色/build')).toBeChecked(); await expect(check('角色/build')).toBeDisabled();
    expect((await summary()).jobs.map(j => j.id)).toEqual(jobsBefore);
    expect((await instance.evaluate(() => global.__exclusionRequests)).filter(p => p !== '/summary'
      && !p.endsWith('/directories'))).toEqual([]);
    await page.locator('.exclusion-selections>summary').click();
    await expect(page.locator('.exclusion-selections')).toContainText('所有层级的同名文件夹');
    await page.getByRole('checkbox', { name: '取消排除 build', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '取消排除 build', exact: true })).toHaveCount(0);
    await page.getByRole('checkbox', { name: '取消排除 已移走', exact: true }).click();
    await check('build').check();
    await expect(check('角色/build')).not.toBeChecked();
    await preview(); await expect(page.locator('.impact')).toContainText('恢复 1 个');
    await save(); await expect(dialog()).toHaveCount(0); await settled();
    expect(await rules()).toEqual(['./build']);
    await openEditor(); await expect(check('build')).toBeChecked();
    await check('build').uncheck(); await expand('角色');
    await check('角色/build').check();
    expect(await check('角色').evaluate(el => el.indeterminate)).toBe(true);
    await preview(); await expect(page.locator('.impact')).toContainText('新增 1 个');
    await check('场景').check();
    await expect(page.locator('.impact')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存排除规则', exact: true })).toBeDisabled();
    await expand('场景'); await expect(check('场景/灯光')).toBeChecked(); await expect(check('场景/灯光')).toBeDisabled();
    await check('场景').uncheck(); await check('角色').check();
    await expect(check('角色/build')).toBeDisabled();
    await page.locator('.exclusion-selections>summary').click();
    await expect(page.locator('.exclusion-selected')).toHaveCount(1);
    await check('角色').uncheck(); await expect(check('角色/build')).not.toBeChecked();
    await check('场景').check(); await check('角色/build').check();
    await preview(); await save(); await settled();
    expect(await rules()).toEqual(['./场景', './角色/build']);
    const excludedAsset = await page.evaluate(() => window.prism.api('/assets/00000000000000000000000000000005'));
    expect(excludedAsset.tags).toEqual(['保留标签']); expect(excludedAsset.favorite).toBe(true);
    expect(excludedAsset.collections[0].name).toBe('测试集合');
    await openEditor();
    await expect(check('场景')).toBeChecked(); await expand('角色'); await expect(check('角色/build')).toBeChecked();
    await check('场景').uncheck(); await check('角色/build').uncheck();
    await preview(); await expect(page.locator('.impact')).toContainText('恢复 2 个');
    await save(); await settled(); expect(await rules()).toEqual([]);
    expect((await summary()).total).toBe(5);
    await openEditor(); await check('场景').check();
    await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '关联目录', exact: true })).toBeVisible();
    expect(await rules()).toEqual([]);
    await openEditor(); await expand('空文件夹');
    await expect(page.getByRole('button', { name: '折叠文件夹 空文件夹', exact: true })).toHaveCount(0);
    fs.mkdirSync(path.join(originals, '新建文件夹'));
    await page.getByRole('button', { name: '刷新文件夹列表' }).click();
    await expect(check('新建文件夹')).toBeVisible();
    await expand('带 空格'); await check('带 空格/[草稿]?').check();
    await preview(); await expect(page.locator('.impact')).toContainText('新增 0 个'); await save(); await settled();
    expect(await rules()).toEqual(['./带 空格/[草稿]?']);
    // API read errors and authorization are exercised without changing the catalog.
    const invalid = await page.evaluate(async () => {
      const connection = await window.prism.connection();
      const request = async parent => (await fetch(`${connection.base}/folders/fixture/directories?parent=${encodeURIComponent(parent)}`,
        { headers: { Authorization: `Bearer ${connection.token}` } })).status;
      const denied = (await fetch(`${connection.base}/folders/fixture/directories`)).status;
      return [denied, await request('../'), await request('linked/build'), await request('不存在')];
    });
    expect(invalid).toEqual([401, 400, 400, 404]);
    const rejected = await page.evaluate(async () => {
      const routes = ['/folders/fixture/directories?parent=x&unexpected=1', '/summary?parent=x',
        '/folders/fixture/directories?parent=%ZZ', '//example.com/summary'];
      return Promise.all(routes.map(async route => {
        try { await window.prism.api(route); return false; } catch (error) { return error.message.includes('无效请求'); }
      }));
    });
    expect(rejected).toEqual([true, true, true, true]);
    await openEditor();
    // Inject a delayed real read, then refresh, proving stale results cannot
    // replace the newly read tree. The request handler is restored afterwards.
    await instance.evaluate(() => {
      global.__originalDirectoryFetch = global.fetch;
      global.__delayDirectory = true;
      global.fetch = async (...args) => {
        const result = await global.__originalDirectoryFetch(...args);
        if (args[0].includes('/directories') && global.__delayDirectory) {
          global.__delayDirectory = false;
          await new Promise(resolve => { global.__releaseDirectory = resolve; });
        }
        return result;
      };
    });
    await expand('角色');
    await expect.poll(() => instance.evaluate(() => typeof global.__releaseDirectory)).toBe('function');
    await page.getByRole('button', { name: '刷新文件夹列表' }).click();
    await expect(check('场景')).toBeVisible();
    await instance.evaluate(() => { global.__releaseDirectory(); });
    await expect(check('角色/build')).toHaveCount(0);
    await expand('角色'); await expect(check('角色/build')).toBeVisible();
    await instance.evaluate(() => { global.fetch = global.__originalDirectoryFetch; });
    // Offline listing retains saved selections so they can be removed.
    fs.renameSync(originals, `${originals}-offline`);
    await page.getByRole('button', { name: '刷新文件夹列表' }).click();
    await expect(page.locator('.directory-error')).toContainText('磁盘连接');
    await page.locator('.exclusion-selections>summary').click();
    await expect(page.getByRole('checkbox', { name: '取消排除 带 空格/[草稿]?', exact: true })).toBeChecked();
    fs.renameSync(`${originals}-offline`, originals);
    await page.getByRole('button', { name: '重试读取', exact: true }).click();
    await expect(check('角色')).toBeVisible();
    await page.getByRole('button', { name: '关闭目录排除', exact: true }).click();
    // Capture light/dark and assert fixed footer/header + inset long-list scroll.
    for (const mode of ['浅色', '深色']) {
      await page.getByRole('tab', { name: '外观', exact: true }).click();
      await page.getByRole('button', { name: mode, exact: true }).click();
      await page.getByRole('tab', { name: '关联目录', exact: true }).click();
      await openEditor(); await expect(check('场景')).toBeVisible();
      await check('场景').check(); await expand('场景'); await expand('角色');
      await check('角色/build').check(); await preview();
      await screenshot(`exclusions-${mode === '浅色' ? 'light' : 'dark'}.png`);
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
      const bounds = await dialog().boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      const scroller = page.locator('.exclusion-content'), heading = dialog().locator('.panel-heading');
      const footer = page.locator('.exclusion-footer');
      const headerY = (await heading.boundingBox()).y, footerY = (await footer.boundingBox()).y;
      expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      for (const end of ['top', 'bottom']) {
        await scroller.evaluate((el, end) => { el.scrollTop = end === 'top' ? 0 : el.scrollHeight; }, end);
        const sb = await scroller.boundingBox();
        expect(sb.x + sb.width).toBeLessThanOrEqual(bounds.x + bounds.width - 5);
        expect(sb.y + sb.height).toBeLessThanOrEqual(footerY);
        expect((await heading.boundingBox()).y).toBe(headerY); expect((await footer.boundingBox()).y).toBe(footerY);
        await expect(page.getByRole('button', { name: '关闭目录排除', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '保存排除规则', exact: true })).toBeInViewport();
      }
      await screenshot(`exclusions-${mode === '浅色' ? 'light' : 'dark'}-scroll.png`);
      await page.getByRole('button', { name: '关闭目录排除', exact: true }).click();
    }
    // A compact version of the same real fixture makes the overview readable.
    for (const name of ['动作', '参考图', '材质', '模型', '空文件夹', '新建文件夹', '带 空格',
      ...Array.from({ length: 18 }, (_, n) => `项目-${String(n).padStart(2, '0')}`)]) {
      fs.rmSync(path.join(originals, name), { recursive: true });
    }
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
    for (const mode of ['浅色', '深色']) {
      await page.getByRole('tab', { name: '外观', exact: true }).click();
      await page.getByRole('button', { name: mode, exact: true }).click();
      await page.getByRole('tab', { name: '关联目录', exact: true }).click();
      await openEditor(); await expect(check('场景')).toBeVisible();
      await page.locator('.exclusion-selections>summary').click();
      await page.getByRole('checkbox', { name: '取消排除 带 空格/[草稿]?', exact: true }).click();
      await expand('场景'); await check('场景').check();
      await expand('角色'); await check('角色/build').check();
      await preview();
      await page.locator('.exclusion-content').evaluate(el => { el.scrollTop = 0; });
      await screenshot(`exclusions-overview-${mode === '浅色' ? 'light' : 'dark'}.png`);
      await page.getByRole('button', { name: '关闭目录排除', exact: true }).click();
    }
    await settled();
    expect(errors).toEqual([]);
    expect(fs.existsSync(path.join(originals, '场景/环境.png'))).toBe(true);
    console.log(`EXCLUSIONS_UI_OK: real folder checkbox tree, legacy/missing selections, exact same-name paths, parent/child/mixed states, preview invalidation, save/reopen/restore/metadata, Escape/cancel, refresh/stale reads, empty/offline/auth/traversal errors, light/dark and fixed/inset scroll; model remained unloaded; screenshots ${output}`);
  } catch (error) {
    if (page && !page.isClosed()) await screenshot('exclusions-failure.png').catch(() => {});
    console.error(`Exclusion UI failure artifacts: ${output}`);
    throw error;
  } finally {
    if (instance) await instance.close();
    if (output !== temp) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
