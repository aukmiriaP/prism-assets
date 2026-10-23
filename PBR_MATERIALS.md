# Prism PBR 材质工作流

本轮实现范围：独立 PBR 材质包导入、通道识别与人工修正、材质球/平面/立方体预览、
材质资产检索与整理、增量更新，以及导出可携带材质包并在 Blender 中应用。
继续采用现有中性灰桌面界面；材质编辑窗口的标题和操作固定，内容独立滚动。
本轮不扩展原生 Unity/UE 材质、Substance 图、动画或任意 Shader 编译。

## 用户流程

1. 左侧「PBR 材质」进入材质库，点击「导入材质包」选择一个本地文件夹。
2. 读取此文件夹及其子文件夹内的贴图，显示实际文件名和尺寸；提出通道建议。
   文件名含义不明确或同一通道存在多个不同候选时，保留空选项并说明，允许用户指定。
3. 用户可修改名称、贴图、打包通道、反相、法线方向、颜色/粗糙度/金属度、
   法线强度、UV 重复。材质球、平面和立方体提供可旋转的标准 PBR 预览。
4. 保存后新增一个材质资产，后台生成球体封面并编码语义向量。
   材质支持标签、收藏、集合、关键词/语义/相似检索；编辑保留 ID 和整理信息。
5. 贴图变化后重新生成受影响的材质，不更新无关资产；失联或缺贴图会明确显示。
6. 「导出 Blender 材质包」保存 ZIP，包含规范化贴图和配置。
   Blender 配套插件通过「文件 → 导入 → Prism PBR 材质包」读取 ZIP，
   建立 Principled BSDF 节点并应用到选中的网格，不覆盖原贴图。

## 数据与 API 约定

在现有 `assets` 表增量添加 `material_data TEXT`，新增 `kind='material'`、`ext='material'`。
材质的 `path` 使用原始材质目录；每个目录对应一个材质定义，原目录不写配置。
材质配置/缓存仅保存在应用数据目录。导入复用已关联的上级目录，或关联该材质目录；
不得破坏已有目录的非重叠约束。原图继续保持原位置。

配置：

```json
{
  "version": 1,
  "source_dir": "/absolute/source",
  "name": "Wood",
  "maps": {
    "base_color": {"file": "wood_diff_1k.jpg", "channel": "rgb", "invert": false},
    "normal": {"file": "wood_nor_gl_1k.jpg", "channel": "rgb", "invert": false},
    "roughness": {"file": "wood_orm_1k.jpg", "channel": "g", "invert": false},
    "metallic": {"file": "wood_orm_1k.jpg", "channel": "b", "invert": false},
    "ao": {"file": "wood_orm_1k.jpg", "channel": "r", "invert": false}
  },
  "normal_format": "opengl",
  "color": "#ffffff",
  "roughness": 1,
  "metallic": 1,
  "normal_strength": 1,
  "emissive_strength": 1,
  "opacity": 1,
  "repeat": 1
}
```

可绑定通道：`base_color`、`normal`、`roughness`、`metallic`、`ao`、`emissive`、`opacity`。
Base Color、Normal、Emissive 使用 RGB，其余可指定 R/G/B/A。
正常化时把标量贴图变为各 RGB 通道相同的灰度图；Smoothness 等通过反相转成 Roughness。
DirectX 法线绿色通道反相后转换为 OpenGL 法线，缓存和导出保持同一转换。
颜色/自发光贴图按 sRGB 使用，其余是线性数据。UV 重复和各乘数在两端保持一致。
Blender Principled 无专用 AO 输入：保留 AO 贴图节点并注明用于引擎，不把 AO 擅自乘进颜色。
首版是标准 PBR 预览，不承诺还原任意引擎的着色器/灯光。

`material_data` 包含 `config`、发布后的 `cache`、贴图信息、检查说明和依赖戳。
编辑待处理时保留旧封面，只有完整生成成功后发布新缓存；不混用新配置与旧通道缓存。

- `POST /materials/inspect {path}`：只读扫描、候选贴图、建议配置、歧义/格式说明。
- `POST /materials/preview {config}`：生成规范化贴图缓存，返回预览 ID 和各通道信息。
  不写资产、不调用 embedding/Blender；每个配置的缓存有上限并清理旧缓存。
- `GET /materials/previews/{preview_id}/{role}/preview`：读取规范化贴图，用于编辑器的 Three.js 预览。
- `POST /materials {config}`：添加材质资产并安排索引；重复目录提示编辑已有材质。
- `PATCH /materials/{aid} {config}`：更新定义并安排索引，保留 ID、标签、收藏与集合。
- `DELETE /materials/{aid}`：只移除材质定义与缓存，原贴图保留；目录仍关联。
- `GET /assets/{aid}/material/{role}/preview`：读取已发布通道。
- `GET /assets/{aid}/material/export`：生成可携带 ZIP；Electron 保存对话框写到用户选择的位置。

所有接口沿用本地认证；新增 `materials` 命名空间到 Electron IPC 白名单。
图片查询 token 只用于以 `/preview` 结束的 GET，不开放任意文件读取。

实现位置：`material_assets.py` 负责通道识别与规范化，`material_catalog.py` 负责目录库、
发布缓存与 ZIP 导出，`src/materials.tsx` 提供交互编辑及查看。
`material_worker.py` 与 Blender 插件共用 `blender_material.py`，避免节点语义漂移。
插件 ZIP 由 `scripts/package-material-addon.py` 构建；从磁盘安装后，
使用「文件 → 导入 → Prism PBR Material (.zip)」。需要先选择有 UV 的网格，
替换活动材质槽（没有槽则新增），图片打包到 Blender 项目，支持原生撤销。
导出的标量 PNG 使用相同的 RGB 灰度值和 R 通道描述，法线统一为 OpenGL。

## Catalog 集成约束

- 扫描普通文件时不把材质目录当图片处理，也不在普通文件失联逻辑中标记它。
  另检查材质的目录、绑定贴图和配置依赖戳，将变更材质加入同一索引队列。
- 排除规则判断材质目录时附加一个虚拟文件尾段，以覆盖「所选目录及其子目录」。
  排除、解除关联、重启、缺图恢复和失败重试均保持现有逻辑。
- 用 `model_resources` 的现有父子关系存储材质绑定贴图，让普通浏览和独立图片
  收起这些贴图；关系会随着改绑/移除材质更新。`resource_groups` 仍只返回模型父项。
- `asset_filters`/FastAPI `Filters.kind` 添加 `material`，Summary 添加材质计数。
  图片所属关系返回父资产类型，UI 标题使用「所属资产」。
- 材质关键词匹配名称、源目录、标签和集合；语义向量由真正的材质球渲染生成。
- 保存/移除时若该关联目录正在索引，应明确提示等待，避免配置与索引竞争。
- 索引使用版本化缓存；转换期间再次检查依赖戳，变更时安排重试而不发布过期结果。
- PyInstaller 把 Blender 材质 worker 和共用节点构建模块作为数据打包。

## 文件安全与范围

只读材质源目录；拒绝越界/隐藏/符号链接贴图，验证所有配置文件都在该目录内。
首版扫描最多 256 张图片、8 层子目录；超出时要求选择独立材质包。
支持常用 8 位 Pillow 图片格式，拒绝不能正确解释的数据格式/损坏图，明确显示原因。
单图与像素限额沿用图片索引限制；交互缓存最长边不超过 2048，原文件不修改。
ZIP 插件只读取 JSON 和图片，校验路径与解压大小，不运行包内 Python 或 Blender 文件。
不用上传素材，不改动日常库，不复制模型权重，不强制重新打包应用。

## 验证要求

1. 真实小型文件 + 控制向量：名称识别、候选歧义、ORM/RMA 解通道、Smoothness 反相、
   DX 法线转换、sRGB/数据约定、路径安全、损坏/缺图与尺寸限额。
2. 真实 SQLite：导入、关键词/相似检索、改名/改绑后标签收藏集合保留、排除恢复、
   重启、改图只更新受影响材质、缺图恢复、删除不改原图、任务重试。
3. 隔离 Blender：真实公开纹理的球体渲染；导出 ZIP 后由配套插件建立节点并应用到网格，
   检查通道连接、乘数、法线处理、色彩空间与原文件不变。
4. 真实 Electron + 缓存/控制服务：选择文件夹、实际下拉通道、修订、旋转和形状切换、
   保存回显、检索收藏/集合、导出、取消、错误、浅深色与小窗口滚动；
   保持既有图片、模型、设置与索引任务回归。
5. 本地日常库未发现 PBR 命名的贴图组。使用 Poly Haven 的少量 CC0 1K 真实纹理包，
   放在工作区独立样本目录并保存来源/许可证/校验值。仅获取资产纹理，不用站点示例渲染。
