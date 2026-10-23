// Real Electron, deterministic local fixtures, no Blender or embedding calls.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-appearance-ui-'));
const data = path.join(temp, 'data');
const output = process.env.PRISM_TEST_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
execFileSync(path.join(root, '.venv/bin/python'), ['-c', `
import json,struct,sys,time
from pathlib import Path
from PIL import Image,ImageDraw
from catalog import Catalog
library=Catalog(Path(sys.argv[1]),watch=False)
for n,color in enumerate(["#496cb9","#a28ec9","#78a297"]):
    aid=f"{n+1:032x}"
    image=Image.new("RGB",(256,256),"#f2f3f5")
    ImageDraw.Draw(image).ellipse((50,50,206,206),fill=color)
    original=library.root/f"色彩参考-{n+1}.png"
    image.save(original); image.save(library.thumbs/f"{aid}.webp")
    library.execute("""INSERT INTO assets(id,path,name,ext,size,mtime,width,height,hash,thumbnail,status,added,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?,'ready',?,?)""",
        (aid,str(original),original.name,"png",original.stat().st_size,original.stat().st_mtime_ns,
        256,256,aid,f"{aid}.webp",time.time(),time.time()))
aid=f"{4:032x}"
binary=struct.pack("<9f",-1,-1,0,1,-1,0,0,1,0)
gltf={"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
 "meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],
 "materials":[{"name":"示例材质","doubleSided":True,"pbrMetallicRoughness":{"baseColorFactor":[0.25,0.45,0.8,1],"metallicFactor":0}}],
 "buffers":[{"byteLength":len(binary)}],"bufferViews":[{"buffer":0,"byteLength":len(binary)}],
 "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[-1,-1,0],"max":[1,1,0]}]}
encoded=json.dumps(gltf).encode(); encoded+=b" "*(-len(encoded)%4)
blob=struct.pack("<III",0x46546c67,2,12+8+len(encoded)+8+len(binary))+struct.pack("<II",len(encoded),0x4e4f534a)+encoded+struct.pack("<II",len(binary),0x004e4942)+binary
original=library.root/"舞台测试.glb"; original.write_bytes(blob)
cache=library.models/aid/"fixture"; cache.mkdir(parents=True); (cache/"model.glb").write_bytes(blob)
metadata={"cache":"fixture","vertices":3,"triangles":1,"materials":[{"name":"示例材质","bindings":[]}],
 "resources":[],"warnings":[],"bound_textures":0,"missing_resources":0,"comment":""}
library.execute("""INSERT INTO assets(id,path,name,ext,size,mtime,hash,kind,model_data,status,added,updated)
 VALUES(?,?,?,?,?,?,?,'model',?,'ready',?,?)""",(aid,str(original),original.name,"glb",len(blob),
 original.stat().st_mtime_ns,aid,json.dumps(metadata),time.time(),time.time()))
library.close(); library.worker.join(3); library.db.close()
`, data], { cwd: root });
const env = { ...process.env, PRISM_USER_DATA: path.join(temp, 'electron'), PRISM_DATA_DIR: data };
for (const key of ['ELECTRON_RUN_AS_NODE', 'PRISM_DEV_URL', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) delete env[key];
let instance, page;
const errors = [];
async function launch() {
  instance = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  page = await instance.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await instance.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    global.__appearanceRequests = [];
    const fetch = global.fetch;
    global.fetch = (...args) => {
      global.__appearanceRequests.push(new URL(args[0]).pathname);
      return fetch(...args);
    };
  });
  await expect(page.locator('.asset-card')).toHaveCount(4, { timeout: 60000 });
}
const theme = value => expect(page.locator('html')).toHaveAttribute('data-theme', value);
const openSettings = () => page.getByRole('button', { name: /设置与帮助/ }).click();
const closeSettings = () => page.getByTitle('关闭设置', { exact: true }).click();
async function screenshot(name) {
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await instance.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
}
async function contrastCheck() {
  const ratio = await page.evaluate(() => {
    const color = name => {
      const el = document.createElement('span'); el.style.color = `var(${name})`; document.body.append(el);
      const value = getComputedStyle(el).color.match(/[\d.]+/g).slice(0, 3).map(Number); el.remove(); return value;
    };
    const lum = values => values.reduce((sum, v, i) => {
      v /= 255; return sum + (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
    }, 0);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
    return { text: ratio(color('--accent-text'), color('--panel')),
      button: ratio(color('--on-accent'), color('--accent')) };
  });
  expect(ratio.text).toBeGreaterThanOrEqual(4.5);
  expect(ratio.button).toBeGreaterThanOrEqual(4.5);
}
(async () => {
  try {
    await launch(); await theme('light');
    await expect(page.locator('html')).toHaveAttribute('data-preview-background', 'solid');
    expect(await page.locator('.asset-image').first().evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
    await expect(page.locator('.browse-help>p')).toBeHidden();
    await page.getByLabel('模型浏览说明').click();
    await expect(page.locator('.browse-help>p')).toBeVisible();
    await page.getByLabel('模型浏览说明').click();
    await page.getByLabel('语义搜索').fill('保留未提交的搜索');
    await page.getByRole('button', { name: '素材 色彩参考-1.png', exact: true }).click();
    const selection = await page.locator('.inspector>h2').textContent();
    await page.evaluate(() => { window.__appearanceImage = document.querySelector('.inspector-preview img'); });
    await openSettings();
    await instance.evaluate(() => { global.__appearanceRequests = []; });
    await expect(page.getByRole('button', { name: '浅色', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await screenshot('appearance-light.png');
    await page.getByRole('button', { name: '透明网格', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-preview-background', 'checker');
    expect(await page.locator('.asset-image').first().evaluate(el => getComputedStyle(el, '::before').content)).toBe('""');
    expect(await page.evaluate(() => document.querySelector('.inspector-preview img') === window.__appearanceImage)).toBe(true);
    await page.getByRole('button', { name: '纯色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-preview-background', 'solid');
    for (const mode of ['深色', '浅色']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      await theme(mode === '深色' ? 'dark' : 'light');
      for (const color of ['蓝色', '绿色', '紫色', '橙色', '玫瑰']) {
        await page.getByRole('button', { name: `${color}主题`, exact: true }).click();
        await expect(page.getByRole('button', { name: `${color}主题`, exact: true })).toHaveAttribute('aria-pressed', 'true');
        await contrastCheck();
      }
      for (const color of ['#ffffff', '#000000', '#ffff00', '#777777', '#4d8a83']) {
        await page.getByLabel('自定义主题颜色').fill(color);
        await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe(color);
        await contrastCheck();
      }
    }
    await expect(page.getByLabel('语义搜索')).toHaveValue('保留未提交的搜索');
    await expect(page.locator('.inspector>h2')).toHaveText(selection);
    const paths = await instance.evaluate(() => global.__appearanceRequests);
    expect(paths.filter(p => p !== '/summary')).toEqual([]);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: '跟随系统', exact: true }).click(); await theme('dark');
    await page.emulateMedia({ colorScheme: 'light' }); await theme('light');
    await page.getByRole('button', { name: '深色', exact: true }).click(); await theme('dark');
    await page.emulateMedia({ colorScheme: 'light' }); await theme('dark');
    await screenshot('appearance-dark.png');
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
    const bounds = await page.getByRole('dialog', { name: '设置与帮助', exact: true }).boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    const scroller = page.locator('.settings-content');
    const heading = page.locator('.settings-modal>.panel-heading');
    const headingBounds = await heading.boundingBox();
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    for (const mode of ['浅色', '深色']) {
      await scroller.evaluate(el => { el.scrollTop = 0; });
      await page.getByRole('button', { name: mode, exact: true }).click();
      for (const end of ['top', 'bottom']) {
        await scroller.evaluate((el, end) => { el.scrollTop = end === 'top' ? 0 : el.scrollHeight; }, end);
        const scrollBounds = await scroller.boundingBox();
        expect(scrollBounds.y).toBeGreaterThanOrEqual(headingBounds.y + headingBounds.height - 1);
        expect(scrollBounds.x + scrollBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width - 5);
        expect(scrollBounds.y + scrollBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height - 5);
        expect((await heading.boundingBox()).y).toBe(headingBounds.y);
        expect(await page.locator('.settings-modal').evaluate(el => el.scrollTop)).toBe(0);
        await expect(page.getByTitle('关闭设置', { exact: true })).toBeVisible();
        if (end === 'bottom') await expect(page.locator('.settings-content .help-note')).toBeInViewport();
        await screenshot(`settings-scroll-${mode === '浅色' ? 'light' : 'dark'}-${end}.png`);
      }
    }
    await closeSettings(); await openSettings();
    expect(await scroller.evaluate(el => el.scrollTop)).toBe(0);
    await page.getByRole('button', { name: '跟随系统', exact: true }).click();
    await closeSettings();
    await page.getByRole('button', { name: '素材 舞台测试.glb', exact: true }).dblclick();
    await expect(page.getByLabel('可旋转模型画布').locator('canvas')).toBeVisible();
    await expect(page.locator('.model-loading')).toHaveCount(0, { timeout: 15000 });
    await page.getByLabel('线框', { exact: true }).check();
    await page.evaluate(() => { window.__appearanceCanvas = document.querySelector('.model-canvas canvas'); });
    await instance.evaluate(() => { global.__appearanceRequests = []; });
    await screenshot('appearance-stage-light.png');
    await page.emulateMedia({ colorScheme: 'dark' }); await theme('dark');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.model-canvas')).backgroundColor)).toBe('rgb(32, 32, 34)');
    expect(await page.evaluate(() => document.querySelector('.model-canvas canvas') === window.__appearanceCanvas)).toBe(true);
    await expect(page.getByLabel('线框', { exact: true })).toBeChecked();
    expect((await instance.evaluate(() => global.__appearanceRequests)).filter(p => p !== '/summary')).toEqual([]);
    await screenshot('appearance-stage-dark.png');
    await page.getByTitle('关闭预览', { exact: true }).click();
    await openSettings();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '透明网格', exact: true }).click();
    await instance.close(); instance = null;
    await launch(); await theme('dark'); await openSettings();
    await expect(page.getByLabel('自定义主题颜色')).toHaveValue('#4d8a83');
    await expect(page.getByRole('button', { name: '深色', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '透明网格', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const corrupt of ['not json', '{"mode":"unknown","accent":"red"}']) {
      await page.evaluate(value => localStorage.setItem('prism.appearance.v1', value), corrupt);
      await page.reload(); await theme('light');
      await expect(page.locator('.asset-card')).toHaveCount(4);
      expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('#3b6ee8');
      await expect(page.locator('html')).toHaveAttribute('data-preview-background', 'solid');
    }
    await page.evaluate(() => localStorage.setItem('prism.appearance.v1', '{"mode":"dark","accent":"#19836a"}'));
    await page.reload(); await theme('dark');
    await expect(page.locator('html')).toHaveAttribute('data-preview-background', 'solid');
    await expect(page.locator('.asset-card')).toHaveCount(4);
    expect(errors).toEqual([]);
    console.log(`APPEARANCE_UI_OK: modes, all presets, custom color contrast, OS changes, background toggle and persistence, legacy/corrupt storage, collapsed help, narrow window, inset scroll bounds at both ends, fixed close button, retained selection/search, no catalog requests or image/3D canvas reload; screenshots ${output}`);
  } finally {
    if (instance) await instance.close();
    if (output !== temp) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
