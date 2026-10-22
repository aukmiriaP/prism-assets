const packager = require('@electron/packager');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
(async () => {
  const build = process.env.PRISM_BUILD_DIR || path.join(root, 'build');
  const service = path.join(build, 'service');
  if (!fs.existsSync(path.join(service, 'prism-service/prism-service'))) {
    throw new Error('先运行 npm run freeze 构建 Python 服务');
  }
  const stage = path.join(build, 'desktop-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const name of ['electron', 'dist']) fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, main: pkg.main, description: pkg.description, author: 'Prism Assets'
  }, null, 2));
  const bundleModel = process.env.PRISM_BUNDLE_MODEL === '1';
  const extraResource = [service];
  if (bundleModel) {
    extraResource.push(path.join(root, 'models'));
  } else {
    const modelDir = path.resolve(process.env.PRISM_MODEL_DIR || path.join(root, 'models', 'embeddinggemma-2-bf16'));
    if (!fs.existsSync(path.join(modelDir, 'model.safetensors'))) {
      throw new Error('共享模型不存在，请设置 PRISM_MODEL_DIR 或先下载模型');
    }
    const location = path.join(build, 'model-location.json');
    fs.writeFileSync(location, JSON.stringify({ model_dir: modelDir }, null, 2));
    extraResource.push(location);
    console.log('本机包复用模型：' + modelDir);
  }
  const paths = await packager({
    dir: stage, name: 'Prism Assets', platform: 'darwin', arch: 'arm64',
    electronVersion: require('electron/package.json').version,
    out: process.env.PRISM_PACKAGE_OUT || path.join(root, 'release'), overwrite: true, asar: true,
    appBundleId: 'local.prism.assets', appCategoryType: 'public.app-category.graphics-design',
    icon: fs.existsSync(path.join(root, 'build/Prism.icns')) ? path.join(root, 'build/Prism.icns') : undefined,
    extraResource,
    extendInfo: { NSHighResolutionCapable: true, LSMinimumSystemVersion: '14.0',
      NSHumanReadableCopyright: 'Prism Assets · Local visual asset library' }
  });
  const app = path.join(paths[0], 'Prism Assets.app');
  // Ad-hoc signing is sufficient for a locally built app, not distribution notarization.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log('APP=' + app);
})().catch(error => { console.error(error); process.exitCode = 1; });
