# 小镜 XiaoJing

一个跑在自己电脑上的 AI 伙伴。聊天、看图、画图、剪视频、作曲、写代码，全部在你本机完成；换成云端模型时，也只有你主动发起的请求会出网。

数据全部是本地明文 JSON，不经过任何小镜自己的服务器。

---

## 下载即用

1. 打开 [Releases](https://github.com/xulianglong-akk/xiaojing/releases/latest)，下载最新的 `XiaoJing-*-win-x64.zip`
2. 解压到任意目录，运行 `XiaoJing.exe`
3. 免安装、不写注册表。首次启动会自动创建数据目录，默认 `D:\小镜数据`（没有 D 盘时用「文档\小镜数据」），可在「设置 → 数据」里迁移

> 应用未做代码签名，Windows SmartScreen 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。

系统要求：Windows 10 / 11 x64。只用云端模型没有额外硬件要求；跑本地模型建议 8GB 以上显存、16GB 以上内存。

## 第一次使用

小镜不预置任何 API Key，启动后先配置一个可用模型。

**用云端模型**

1. 打开「设置 → 模型」→「＋ 添加模型」
2. 选厂商（OpenAI / Anthropic / DeepSeek / GLM / Kimi / OpenRouter），或选「自定义」填一个 OpenAI 兼容端点
3. 填 API Key，保存后会自动拉取该厂商的模型列表
4. 回到聊天页，在输入区右下角选模型即可

API Key 用 Windows DPAPI 加密保存在本机，明文不落盘。

**用本地 Ollama**

1. 安装 [Ollama](https://ollama.com)，至少拉一个模型，例如 `ollama pull qwen3:8b`
2. 在「设置 → 本地模型」确认程序目录（默认 `E:\ollama`，按实际安装位置改）
3. 小镜启动时会自动检查并拉起 Ollama，退出时一并关闭；已经在跑的不会重复启动
4. 聊天页模型选择器里选本地模型即可，对话全程不出网

**可选：本地生成**

生图 / 生视频 / 生音乐需要自备 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 便携版和对应模型文件。在「设置 → 生图视频」填 ComfyUI 根目录（含 `run_nvidia_gpu.bat`），模型文件就绪后对应选项才会出现。

**可选：联网搜索**

聊天输入区的 🌐 开关，无需配置 Key，走 DuckDuckGo，失败自动回落 Bing。

## 它能做什么

**聊天**
流式输出、思考过程展开、上下文预算可调、超预算自动压缩成长期记忆。支持本地 Ollama 和 OpenAI / Anthropic 兼容的云端接口切着用。

**看图**
发图片给它，用的是你配置的视觉模型。

**生图 / 生视频 / 生音乐**
接本地 ComfyUI，模型、尺寸、时长都能选。生成的成品直接落盘，可保存、可重新生成。

**角色卡**
给 AI 一个人设（说话方式、身份、你们的关系），它会一直按这个人设说话。你说「记住这件事」，它会立刻记进长期记忆，后面主动用上。

**群聊**
把几个角色拉到一个群里，它们会轮流接话，也可以用 `@名字` 指定谁说。

**文件操作（Codex 式）**
指定一个工作目录，让它读文件、改文件、跑命令。三种权限：只读 / 改动前问我 / 完全访问。改之前会先给你看计划。

## 技术栈

| 层 | 用的什么 |
| --- | --- |
| 外壳 | Electron 45 |
| 界面 | React 19 + TypeScript |
| 构建 | electron-vite + electron-builder |
| 本地模型 | Ollama（对话 / 视觉 / 压缩） |
| 生成 | ComfyUI（图像 / 视频 / 音频） |

## 从源码运行

```bash
npm install
npm run dev      # 开发模式
npm run build    # 只构建前端产物
npm run dist     # 打 Windows 安装包（NSIS）
```

用 Node.js 22+（本项目在 Node 24 下开发）。

## 数据与隐私

- 聊天记录、机器人、长期记忆、生成的图片 / 视频 / 音乐都是数据目录下的明文 JSON 或文件，随时可以打包带走
- 不埋点、不上报、没有自有服务器
- API Key 用系统级加密（DPAPI）保存，明文不落盘
- 出网只发生在调用你配置的模型 API、联网搜索，以及你主动发起的其他请求
- 「设置 → 数据」支持一键导出全部数据，也可以彻底删除

详见 [PRIVACY.md](PRIVACY.md)。

## 目前只支持 Windows

打包目标是 Windows x64。Electron 本身跨平台，但本地服务的启动逻辑、路径处理和窗口行为都是按 Windows 写的。

## 许可证

[MIT](LICENSE)
