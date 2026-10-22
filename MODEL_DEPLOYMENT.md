# EmbeddingGemma 2：Mac 本地部署

这是桌面应用开发前的模型部署记录。桌面应用的启动方式和功能见 `README.md`；
下方 `start.command` 启动的是独立的旧版向量 API，使用桌面应用时不需要运行。

已在 Apple M5 / 16GB / macOS 26.6.2 / Python 3.11 上部署并验证。
用途：为后续美术素材检索提供本地文字、图片向量，不需要先准备素材库。

## 启动和使用

在 Finder 中双击本目录的 `start.command`，或运行：

```bash
cd /Users/bytedance/Documents/graduation/asset-search
./start.command
```

看到 `Application startup complete` 后，即可访问：

- 接口调试页：http://127.0.0.1:8765/docs
- 健康检查：http://127.0.0.1:8765/health

调试页展开 `POST /embed/text`，点击 **Try it out**，填写：

```json
{
  "texts": ["冷色调的石制拱门", "一只在草地上奔跑的小狗"],
  "task": "query",
  "dimensions": 768
}
```

点击 **Execute**，返回每条文字的 768 维向量。
图片使用 `POST /embed/image` 上传 PNG、JPEG 或 WebP。

核心推理完全在本地，服务只监听本机地址。API 调试页采用 FastAPI 默认
Swagger UI，其页面资源可能需要联网；离线使用可直接调用 API 或命令行。
这不是聊天模型，返回数字向量是正常行为。

启动脚本会在当前终端持续运行，按 Ctrl+C 停止。未设置开机自动启动。
若提示端口被占用，先查看 `/health`，已有服务可直接使用，无需重复启动。

## 命令行

```bash
cd /Users/bytedance/Documents/graduation/asset-search

# 中文文字；未指定输出路径时，只打印概要和向量前 8 维。
.venv/bin/python embed.py --text "冷色调的石制拱门"

# 图片，之后替换为真实图片路径。
.venv/bin/python embed.py --image "/完整路径/图片.png"

# 输出 256 维，并保存完整向量。
.venv/bin/python embed.py --text "石制拱门" --dimensions 256 --output "/tmp/query.npy"
```

API 示例：

```bash
curl http://127.0.0.1:8765/embed/text \
  -H 'Content-Type: application/json' \
  -d '{"texts":["冷色调的石制拱门"],"task":"query","dimensions":768}'

curl 'http://127.0.0.1:8765/embed/image?dimensions=256' \
  -F 'file=@/完整路径/图片.png'
```

同一索引须使用同一模型、预处理、维度和提示规则。向量已 L2 归一化，
同维度向量的点积可作余弦相似度；分数不是“正确概率”。
文字查询使用 `query`，文字描述入库使用 `document`，
对称文字相似度任务使用 `similarity`；图片不添加文字任务前缀。

## 已验证的环境

| 项目 | 配置 |
|---|---|
| 原始模型 | `google/embeddinggemma-2` |
| 实际下载 | `mlx-community/embeddinggemma-2-bf16`，社区 MLX 转换版 |
| 固定仓库版本 | `1a4ffddb7905d3f63486748deabe091a01fb6201` |
| 权重精度 | BF16，不使用 FP16 或 4bit |
| 推理引擎 | MLX 0.32.4 / Metal GPU |
| 模型实现 | mlx-vlm 0.7.9 |
| Transformers | 5.20.2 |
| 运行模态 | 文字、图片；音频编码器不加载 |
| 向量维度 | 768 默认；可选 512、256、128，截断后重新归一化 |
| 权重文件 | 1,488,914,930 字节，约 1.49GB |
| 下载完整性 | SHA256 与 Hugging Face LFS 元数据一致 |

权重 SHA256：

```text
ffaf2604b011ad0634022529bac930a4f6a2feba22687d8d5890434d186b459c
```

下载的是完整 BF16 checkpoint，运行时去掉音频模块；磁盘文件大小不会因此减少。
`requirements.lock.txt` 保存本次实测依赖版本，独立 `.venv` 与 ComfyUI 环境隔离。

## 本机验证记录

- 模型加载后返回有限值、单位长度向量，中文输入成功。
- 将 Python socket 连接禁用后，模型加载与图文编码仍正常。
- 三张临时生成的红圆、蓝方、绿三角测试图，与对应中文描述的最高相似度均正确。
- 256 / 512 / 768 维文字编码及归一化通过。
- HTTP 健康检查、文字编码、图片上传通过；空文本、非法维度、无效图片返回 422。

一次基础测试的实际耗时：

| 操作 | 观测值 |
|---|---|
| 模型加载（不含 Python 导入耗时） | 约 1.18 秒 |
| 三条中文查询一起编码 | 约 0.19 秒 |
| 首张 384×384 图片编码 | 约 1.90 秒 |
| 后两张图片编码 | 约 0.24 / 0.21 秒 |
| MLX 峰值内存 | 约 1,580 MiB，即 1.54 GiB |

首轮推理会受 Metal 编译和缓存影响。以上是小样本功能验证，不是吞吐量、
美术语义质量或整机内存基准；真实素材库的准确率和索引速度尚未评测。

## 实现与限制

- `embed.py`：可复用 Python 类与命令行；仅使用本地权重。
- `server.py`：常驻模型的 FastAPI 服务，端口 8765，单进程串行推理。
- `download_model.py`：从公开仓库下载固定版本，写入模型来源清单。
- `start.command`：双击或命令行启动。
- `model_manifest.json`：来源、版本和模态记录。

为控制内存，每次文字请求最多 8 条，每条最多 4000 字符；
图片文件最多 20MB、4000 万像素，纠正 EXIF 方向并转 RGB，
长边超过 2048 时保持比例缩小。尚未实现素材扫描、向量库、检索界面或 Blender 插件。

本部署显式加载 MLX 的 `EmbeddingGemma2Processor`。通用 `AutoProcessor`
在当前 Transformers 版本会选择依赖 PyTorch/Torchvision 的处理器，
即使只使用图片也可能报缺依赖；不要直接替换回通用加载器。

MLX 推理由一个进程串行执行，避免多个并发任务同时占用统一内存。
首次启动的依赖导入可能需要十几秒，看到启动完成日志再发请求。

## 重建环境

当前已经安装，无需重复执行。以后重建时：

```bash
cd /Users/bytedance/Documents/graduation/asset-search
/opt/homebrew/bin/python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
.venv/bin/python download_model.py
./start.command
```

模型源码与说明：

- https://huggingface.co/google/embeddinggemma-2
- https://huggingface.co/mlx-community/embeddinggemma-2-bf16
- https://github.com/Blaizzy/mlx-vlm/blob/main/mlx_vlm/models/embedding_gemma2/README.md
