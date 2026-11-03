// Real Electron, deterministic fixture library. Prompt vectors are seeded, so no embedding model loads.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-autotags-ui-'));
const data = path.join(temp, 'data');
const output = process.env.PRISM_TEST_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
execFileSync(path.join(root, '.venv/bin/python'), ['-c', `
import json,sys,time
import numpy as np
from pathlib import Path
from PIL import Image,ImageDraw
from catalog import Catalog, PROFILE
from auto_tags import DEFAULT_VOCABULARY
library=Catalog(Path(sys.argv[1]),watch=False)
category=next(g for g in DEFAULT_VOCABULARY if g["id"]=="category")
axis={l["prompt"]:i for i,l in enumerate(category["labels"])}
def vec(i,noise=0.0):
    v=np.full(768,noise,dtype=np.float32); v[i]=1; return v/np.linalg.norm(v)
for prompt,i in axis.items():
    library.execute("INSERT INTO tag_prompt_vectors VALUES(?,?,?)",(prompt,PROFILE,vec(i).tobytes()))
# Four props (axis 1) in red, two scenes (axis 0) in blue.
specs=[("道具",1,"#c8322a")]*4+[("场景",0,"#2f5fd0")]*2
for n,(name,i,color) in enumerate(specs):
    aid=f"{n+1:032x}"
    image=Image.new("RGB",(256,256),color)
    ImageDraw.Draw(image).rectangle((96,96,160,160),fill="#ffffff")
    original=library.root/f"{name}-{n+1}.png"
    image.save(original); image.save(library.thumbs/f"{aid}.webp")
    library.execute("""INSERT INTO assets(id,path,name,ext,size,mtime,width,height,hash,thumbnail,vector,status,added,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'ready',?,?)""",
        (aid,str(original),original.name,"png",original.stat().st_size,original.stat().st_mtime_ns,256,256,aid,
         f"{aid}.webp",vec(i,0.01).tobytes(),time.time()+n,time.time()))
library.close(); library.worker.join(3); library.db.close()
`, data], { cwd: root });
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: data };
for (const key of ['ELECTRON_RUN_AS_NODE', 'PRISM_DEV_URL', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) delete env[key];
let instance, page;
const errors = [];
async function screenshot(name) {
  await instance.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); });
  await page.waitForTimeout(200);
  const png = await instance.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
}
const python = code => execFileSync(path.join(root, '.venv/bin/python'), ['-c', code, data], { cwd: root }).toString().trim();
(async () => {
  try {
    instance = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
    page = await instance.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('.asset-card')).toHaveCount(6, { timeout: 60000 });

    // Detail: a single prop gets 道具 and its dominant red, shown as dashed suggestions.
    await page.getByRole('button', { name: '素材 道具-1.png', exact: true }).click();
    const suggestions = page.getByLabel('建议标签', { exact: true });
    await expect(suggestions.getByRole('button', { name: '采纳建议标签 道具' })).toBeVisible({ timeout: 30000 });
    await expect(suggestions.getByRole('button', { name: '采纳建议标签 红色' })).toBeVisible();
    await expect(suggestions.getByRole('button', { name: '采纳建议标签 场景' })).toHaveCount(0);
    // The basis shows in the panel on hover and on keyboard focus (native title tooltips are unreliable here).
    const basis = suggestions.locator('.suggestion-basis');
    await expect(basis).toHaveText('悬停或聚焦建议标签可查看依据');
    await suggestions.getByRole('button', { name: '采纳建议标签 道具' }).hover();
    await expect(basis).toContainText('道具：类别 · 依据英文描述 · 组内份额');
    await suggestions.getByRole('button', { name: '采纳建议标签 红色' }).hover();
    await expect(basis).toContainText('红色：主色 · 依据像素颜色 · 画面占比');
    await page.mouse.move(5, 5);
    await expect(basis).toHaveText('悬停或聚焦建议标签可查看依据');
    await suggestions.getByRole('button', { name: '采纳建议标签 道具' }).focus();
    await expect(basis).toContainText('道具：类别');
    await expect(suggestions.getByRole('button', { name: '采纳建议标签 道具' })).toHaveAttribute('aria-describedby', /basis-/);
    await suggestions.getByRole('button', { name: '采纳建议标签 道具' }).hover();
    await screenshot('autotags-detail.png');
    await suggestions.getByRole('button', { name: '采纳建议标签 道具' }).click();
    await expect(page.locator('.asset-tags>span', { hasText: '道具' })).toBeVisible();
    await expect(suggestions.getByRole('button', { name: '采纳建议标签 道具' })).toHaveCount(0);
    await suggestions.getByRole('button', { name: '忽略建议标签 红色' }).click();
    await expect(suggestions.getByRole('button', { name: '采纳建议标签 红色' })).toHaveCount(0);
    await expect(page.locator('.asset-tags>span', { hasText: '红色' })).toHaveCount(0);

    // Bulk: the remaining five cards are grouped by label, then accepted / dismissed in one click each.
    await page.getByRole('button', { name: '素材 道具-2.png', exact: true }).click({ modifiers: ['Meta'] });
    await page.getByRole('button', { name: '全选已显示项' }).click();
    await page.getByRole('button', { name: '建议标签', exact: true }).click();
    const review = page.getByRole('region', { name: '批量建议标签' });
    const row = label => review.locator('.suggestion-row', { has: page.locator('strong', { hasText: new RegExp(`^${label}$`) }) });
    await expect(row('道具')).toContainText('3 个文件', { timeout: 30000 });
    await expect(row('场景')).toContainText('2 个文件');
    await expect(row('红色')).toContainText('3 个文件');
    await screenshot('autotags-bulk.png');
    await row('场景').getByRole('button', { name: '采纳' }).click();
    await expect(row('场景')).toHaveCount(0);
    await row('红色').getByRole('button', { name: '忽略' }).click();
    await expect(row('红色')).toHaveCount(0);
    const stored = JSON.parse(python(`
import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]+"/catalog.sqlite3")
print(json.dumps({"tags":{n:json.loads(t) for n,t in db.execute("SELECT name,tags FROM assets ORDER BY name")},
 "dismissed":sorted(f"{n}:{l}" for n,l in db.execute("SELECT a.name,d.label FROM tag_dismissals d JOIN assets a ON a.id=d.asset_id"))},ensure_ascii=False))`));
    expect(stored.tags['道具-1.png']).toEqual(['道具']);
    expect(stored.tags['场景-5.png']).toEqual(['场景']);
    expect(stored.tags['场景-6.png']).toEqual(['场景']);
    expect(stored.tags['道具-2.png']).toEqual([]);
    expect(stored.dismissed).toEqual(['道具-1.png:红色', '道具-2.png:红色', '道具-3.png:红色', '道具-4.png:红色']);

    // Settings: disabling every group hides detail suggestions; reset restores defaults.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('tab', { name: '自动标签', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: '自动标签', exact: true });
    await expect(panel.getByLabel('启用分组 类别')).toBeChecked();
    await expect(panel.getByLabel('场景 英文描述')).toHaveValue('environment concept art');
    await screenshot('autotags-settings.png');
    for (const name of ['类别', '主色']) await panel.getByLabel(`启用分组 ${name}`).uncheck();
    await panel.getByRole('button', { name: '保存词表' }).click();
    await expect(panel.getByText('已保存')).toBeVisible();
    await page.getByTitle('关闭设置', { exact: true }).click();
    await page.getByRole('button', { name: '素材 道具-3.png', exact: true }).click();
    await expect(page.getByLabel('建议标签', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /设置与帮助/ }).click();
    await page.getByRole('tab', { name: '自动标签', exact: true }).click();
    await panel.getByRole('button', { name: '恢复默认' }).click();
    await expect(panel.getByLabel('启用分组 类别')).toBeChecked();
    await panel.getByLabel('场景 英文描述').fill('');
    await panel.getByLabel('启用分组 类别').uncheck();
    await panel.getByLabel('分组名称').first().fill('');
    await panel.getByRole('button', { name: '保存词表' }).click();
    await expect(panel.locator('.asset-error')).toContainText('名称');
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ ok: true, screenshots: output }));
  } finally {
    if (instance) await instance.close();
    if (!process.env.PRISM_TEST_OUTPUT) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
