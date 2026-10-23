// Test-only service injection. Production Electron, IPC and renderer stay unchanged.
const child = require('node:child_process');
const path = require('node:path');
const spawn = child.spawn;
child.spawn = (executable, args, options) => {
  if (args?.[0] === path.resolve(__dirname, '..', 'app_server.py'))
    args = [path.join(__dirname, 'material_ui_service.py')];
  return spawn(executable, args, options);
};
require('../electron/main.cjs');
