const fs = require('node:fs');
const path = require('node:path');

// Local builds reference the project's one model directory. Portable builds bundle it.
// An explicit runtime override takes precedence in both modes.
function modelDirectory({ override, packaged, resourcesPath, base }) {
  if (override) return path.resolve(override);
  if (!packaged) return path.join(base, 'models', 'embeddinggemma-2-bf16');
  const location = path.join(resourcesPath, 'model-location.json');
  if (fs.existsSync(location)) {
    const config = JSON.parse(fs.readFileSync(location, 'utf8'));
    if (typeof config.model_dir !== 'string' || !path.isAbsolute(config.model_dir)) {
      throw new Error('本机模型路径配置无效，请检查 model-location.json');
    }
    return config.model_dir;
  }
  return path.join(resourcesPath, 'models', 'embeddinggemma-2-bf16');
}

module.exports = { modelDirectory };
