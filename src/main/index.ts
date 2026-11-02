/**
 * 「小镜」主进程入口 —— 窗口、IPC 注册。
 * 隐私总纲：无遥测、无后台外联，网络只由用户操作触发（模型 API / 搜索 / Ollama 本地）。
 */
import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from 'electron'
import { spawnSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import {
  initDataDir,
  getDataDir,
  setDataDir,
  loadSettings,
  saveSettings,
  setProviderKey,
  setSearchKey,
  exportAllData,
  wipeAllData,
  pruneOrphanFiles,
  AppSettings
} from './store'
import { listModels } from './llm'
import { webSearch } from './search'
import { saveImageDataUrl } from './images'
import * as chat from './chat'
import * as agent from './agent'
import * as bots from './bots'
import * as ollama from './ollama'
import * as comfy from './comfyui'
import { loadGlobalMemory, loadSessionMemory, clearSessionMemory } from './memory'
import { dataStats } from './dataStats'

let win: BrowserWindow | null = null

// xjfile:// 作为页面资源（img src）使用前必须注册为标准特权协议，且必须在 app ready 之前
protocol.registerSchemesAsPrivileged([
  { scheme: 'xjfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

function createWindow(): void {
  // 开发态窗口图标（打包后自动使用 exe 内嵌图标）
  const devIcon = path.join(__dirname, '../../icon/icon-256.png')
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#fafafa',
    autoHideMenuBar: true,
    frame: false, // 自绘标题栏（渲染层 TitleBar 组件）
    icon: require('fs').existsSync(devIcon) ? devIcon : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const pushWinState = (): void => win?.webContents.send('win:state', win?.isMaximized() ?? false)
  win.on('maximize', pushWinState)
  win.on('unmaximize', pushWinState)
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  // 所有外链一律交给系统浏览器打开，且仅限用户点击触发
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  // 启动链路任何一步炸掉都会让应用"有进程没窗口"，而 GUI 版没有控制台看不到原因，
  // 所以统一兜底：异常写到 userData/boot-error.log，且尽量把窗口开出来（不让用户面对空白无窗）。
  try {
    initDataDir()
    appLog(`[boot] 小镜 ${app.getVersion()} 启动，数据目录 ${getDataDir()}`)
    chat.purgeEmptySessions() // 清掉历史遗留的空「新会话」
    try {
      comfy.cleanupOrphanGenFiles() // 删作品时文件被占用留下的残留，启动兜底清一次
    } catch {
      /* 清理失败不影响启动 */
    }
    try {
      // 会话 / 记忆 / 机器人 / 群聊的同款孤儿文件
      const chatIds = new Set(chat.listSessions().map((s) => s.id))
      pruneOrphanFiles('chat', chatIds)
      pruneOrphanFiles('chat-memory', chatIds)
      pruneOrphanFiles('bot-chats', new Set(bots.listBots().map((b) => b.id)))
      pruneOrphanFiles('group-chats', new Set(bots.listGroups().map((g) => g.id)))
    } catch {
      /* 同上 */
    }
    registerAvatarProtocol()
    registerIPC()
    createWindow()
    void warmupLocalServices()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  } catch (e) {
    const detail = e instanceof Error ? e.stack || e.message : String(e)
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'boot-error.log'), `${new Date().toISOString()}\n${detail}`)
    } catch {
      /* 连错误都写不出去就只能认了 */
    }
    // 数据目录出问题时也把窗口开出来，至少用户能看到界面（否则表现为"点了没反应"）
    try {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    } catch {
      /* ignore */
    }
  }
})

// 退出时把小镜拉起的本地服务一并关掉（可用设置关掉），保证它在后台不留常驻进程
app.on('will-quit', () => shutdownLocalServices())

/** 轻量文件日志：GUI 版没有控制台，排查"启动时自动拉起失败"这类问题只能靠它。
 *  写在数据目录 logs/app.log，超过 512KB 自动重开，避免无限增长。 */
function appLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.log(msg)
  try {
    const dir = path.join(getDataDir(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'app.log')
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, '')
    fs.appendFileSync(file, line)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 启动即预热本地服务：没运行就在后台静默拉起，不阻塞窗口，失败不打扰用户。
 *  解决「每次开机 / 重启后发现 Ollama、ComfyUI 全没了，得手动点半天才能用」的反复痛点。
 *  纯本机操作（127.0.0.1），不涉及任何外联；用户可在设置里关掉。 */
async function warmupLocalServices(): Promise<void> {
  try {
    const s = loadSettings()
    if (s.autoStartLocal === false) {
      appLog('[warmup] 已在设置里关闭自动拉起，跳过')
      return
    }
    appLog(`[warmup] 开始检查本地服务 ollamaDir=${s.ollamaDir} comfyDir=${s.comfyDir || 'E:\\ComfyUI'}`)
    const jobs: Promise<void>[] = [
      (async () => {
        try {
          if ((await ollama.ollamaStatus()).running) {
            appLog('[warmup] ollama 已在运行')
            return
          }
          const ok = await ollama.startOllamaServe(s.ollamaDir, s.ollamaModelsDir)
          appLog(`[warmup] ollama 拉起结果=${ok}`)
        } catch (e) {
          appLog(`[warmup] ollama 拉起异常: ${e instanceof Error ? e.message : String(e)}`)
        }
      })(),
      (async () => {
        try {
          // 与 comfyConf() 同一个默认：用户从没填过 comfyDir 时也要能自动拉起便携版
          const dir = s.comfyDir || 'E:\\ComfyUI'
          const bat = path.join(dir, 'run_nvidia_gpu.bat')
          if (!fs.existsSync(bat)) {
            appLog(`[warmup] 未找到 ComfyUI 启动脚本，跳过: ${bat}`)
            return
          }
          if ((await comfy.comfyStatus()).running) {
            appLog('[warmup] ComfyUI 已在运行')
            return
          }
          const ok = await comfy.startComfy()
          appLog(`[warmup] ComfyUI 拉起结果=${ok}`)
        } catch (e) {
          appLog(`[warmup] ComfyUI 拉起异常: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    ]
    await Promise.allSettled(jobs)
  } catch (e) {
    // 以前这里是 on the fly 的 void 调用，异常会被静默吞掉，问题无从查起
    appLog(`[warmup] 预热整体失败: ${e instanceof Error ? e.stack || e.message : String(e)}`)
  }
}

/** 退出时收尾：只关「由小镜自己拉起」的本地服务（用户手动开的 ollama / ComfyUI 不动）。
 *  这样就不需要在 Windows 开机启动项里常驻任何东西，用完即走。 */
function shutdownLocalServices(): void {
  try {
    const s = loadSettings()
    if (s.stopLocalOnQuit === false) return
    const pids = [ollama.startedOllamaPid(), comfy.startedComfyPid()].filter((p): p is number => typeof p === 'number' && p > 0)
    for (const pid of pids) {
      try {
        // /T 连子进程一起收：ComfyUI 是 cmd → python 两层
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        appLog(`[quit] 已关闭本地服务 PID=${pid}`)
      } catch {
        /* 关不掉就算了，别卡住退出 */
      }
    }
  } catch {
    /* ignore */
  }
}

// ---------- 自定义头像 ----------

/**
 * xjfile://avatar/<文件名> → 数据目录 avatars/ 下的图片（机器人头像）。
 * xjfile://img/<文件名> → 数据目录 images/ 下的图片（聊天图片 / 生成图片）。
 * 只允许纯文件名（拒绝路径分隔符与 ..），保证只能读到对应目录内。
 * 直接读文件返回 Response（net.fetch 对 file:// 支持不完整，不走它）。
 */
const IMG_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp'
}

const VID_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
  webp: 'image/webp'
}

const AUD_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4'
}

function registerAvatarProtocol(): void {
  protocol.handle('xjfile', (request) => {
    const url = new URL(request.url)
    let sub: string | null = null
    if (url.hostname === 'avatar') sub = 'avatars'
    else if (url.hostname === 'img') sub = 'images'
    else if (url.hostname === 'video') sub = 'videos'
    else if (url.hostname === 'audio') sub = 'audio'
    if (!sub) return new Response('bad request', { status: 400 })
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!name || /[\\/:*?"<>|]/.test(name) || name.includes('..')) {
      return new Response('bad request', { status: 400 })
    }
    const file = path.join(getDataDir(), sub, name)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('not found', { status: 404 })
    const ext = path.extname(name).slice(1).toLowerCase()
    const mime =
      sub === 'videos'
        ? VID_MIME[ext] ?? 'application/octet-stream'
        : sub === 'audio'
          ? AUD_MIME[ext] ?? 'application/octet-stream'
          : IMG_MIME[ext] ?? 'application/octet-stream'
    return new Response(new Uint8Array(fs.readFileSync(file)), {
      headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' }
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

// ---------- IPC ----------

function registerIPC(): void {
  // 通用事件通道：流式输出等
  const emit = (channel: string, event: unknown): void => {
    win?.webContents.send(channel, event)
  }

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    dataDir: getDataDir(),
    platform: process.platform
  }))

  // 窗口控制（自绘标题栏用）
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('win:close', () => win?.close())

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, s: AppSettings) => {
    saveSettings(s)
    return loadSettings()
  })
  ipcMain.handle('settings:setProviderKey', (_e, providerId: string, key: string) => setProviderKey(providerId, key))
  ipcMain.handle('settings:setSearchKey', (_e, which: 'tavily' | 'bocha', key: string) => setSearchKey(which, key))
  ipcMain.handle('settings:setDataDir', async (_e, dir: string) => {
    await setDataDir(dir)
    return getDataDir()
  })
  ipcMain.handle('settings:export', () => exportAllData())
  ipcMain.handle('settings:wipe', () => {
    wipeAllData()
    return true
  })
  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('settings:pickWorkDir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('models:list', async (_e, providerId: string) => listModels(providerId))

  // 聊天图片：选图返回原图（data URL）→ 渲染层发送；粘贴图片直接落盘（返回文件名）
  ipcMain.handle('images:pick', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    const src = r.filePaths[0]
    const ext = (path.extname(src) || '.png').slice(1).toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext
    if (!['png', 'jpeg', 'webp', 'gif', 'bmp'].includes(mime)) return null
    const buf = fs.readFileSync(src)
    return `data:image/${mime};base64,${buf.toString('base64')}`
  })
  ipcMain.handle('images:saveData', (_e, dataUrl: string) => saveImageDataUrl(dataUrl, 'up'))

  // 数据总览（只读统计）
  ipcMain.handle('data:stats', () => dataStats())

  // 自定义头像：选图返回原图（data URL）→ 渲染层框选裁剪 → saveData 落盘
  ipcMain.handle('avatars:pick', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择头像图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    const src = r.filePaths[0]
    const ext = (path.extname(src) || '.png').slice(1).toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext
    if (!['png', 'jpeg', 'webp', 'gif', 'bmp'].includes(mime)) return null
    const buf = fs.readFileSync(src)
    return `data:image/${mime};base64,${buf.toString('base64')}`
  })

  // 保存渲染层裁剪后的头像（PNG data URL → 数据目录 avatars/）
  ipcMain.handle('avatars:saveData', (_e, dataUrl: string) => {
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(dataUrl || ''))
    if (!m) throw new Error('图片数据无效')
    const buf = Buffer.from(m[2], 'base64')
    if (!buf.length || buf.length > 10 * 1024 * 1024) throw new Error('图片数据无效或过大')
    const name = `av_${Date.now().toString(36)}.png`
    fs.mkdirSync(path.join(getDataDir(), 'avatars'), { recursive: true })
    fs.writeFileSync(path.join(getDataDir(), 'avatars', name), buf)
    return `avatars/${name}`
  })

  // 聊天
  ipcMain.handle('chat:listSessions', () => chat.listSessions())
  ipcMain.handle('chat:createSession', (_e, target, title) => chat.createSession(target, title))
  ipcMain.handle('chat:updateSession', (_e, id, patch) => chat.updateSession(id, patch))
  ipcMain.handle('chat:deleteSession', (_e, id) => chat.deleteSession(id))
  ipcMain.handle('chat:getMessages', (_e, id) => chat.getMessages(id))
  ipcMain.handle('chat:stop', (_e, id) => chat.stopChat(id))
  ipcMain.handle('chat:active', () => chat.activeChatSessions())
  ipcMain.handle('chat:listFolders', () => chat.listFolders())
  ipcMain.handle('chat:createFolder', (_e, name: string) => chat.createFolder(name))
  ipcMain.handle('chat:renameFolder', (_e, id: string, name: string) => chat.renameFolder(id, name))
  ipcMain.handle('chat:deleteFolder', (_e, id: string) => chat.deleteFolder(id))
  ipcMain.on('chat:send', (_e, opts) => {
    chat
      .sendChatMessage({ ...opts, emit: (ev) => emit('chat:event', ev) })
      .catch((err) => {
        // 内部已有 try/catch + emit error，这里只会接住更底层的意外（例如 emit 本身失败）。
        // 以前是 .catch(() => {})，出问题时日志里一个字都没有，排查全靠猜。
        appLog(`[chat] 发送链路异常: ${err instanceof Error ? err.stack || err.message : String(err)}`)
        emit('chat:event', { type: 'error', sessionId: opts?.sessionId, message: '内部错误，详情见日志' })
      })
  })

  // 记忆
  ipcMain.handle('memory:global', () => loadGlobalMemory())
  ipcMain.handle('memory:session', (_e, sessionId: string) => loadSessionMemory(sessionId))
  ipcMain.handle('memory:clearSession', (_e, sessionId: string) => clearSessionMemory(sessionId))

  // Codex
  ipcMain.handle('codex:listSessions', () => agent.listCodexSessions())
  ipcMain.handle('codex:createSession', (_e, workdir: string, target) => agent.createCodexSession(workdir, target))
  ipcMain.handle('codex:updateSession', (_e, id, patch) => agent.updateCodexSession(id, patch))
  ipcMain.handle('codex:deleteSession', (_e, id) => agent.deleteCodexSession(id))
  ipcMain.handle('codex:stop', (_e, id) => agent.stopCodex(id))
  ipcMain.handle('codex:active', () => agent.activeCodexSessions())
  ipcMain.handle('codex:listFolders', () => agent.listCodexFolders())
  ipcMain.handle('codex:createFolder', (_e, name: string) => agent.createCodexFolder(name))
  ipcMain.handle('codex:renameFolder', (_e, id: string, name: string) => agent.renameCodexFolder(id, name))
  ipcMain.handle('codex:deleteFolder', (_e, id: string) => agent.deleteCodexFolder(id))
  ipcMain.on('codex:send', (_e, opts) => {
    agent
      .runCodexTask({ ...opts, emit: (ev) => emit('codex:event', ev) })
      .catch((err) => {
        appLog(`[codex] 执行链路异常: ${err instanceof Error ? err.stack || err.message : String(err)}`)
        emit('codex:event', { type: 'error', sessionId: opts?.sessionId, message: '内部错误，详情见日志' })
      })
  })
  ipcMain.on('codex:approve', (_e, approvalId: string, approved: boolean) => {
    agent.resolveApproval(approvalId, approved)
  })

  // 机器人
  ipcMain.handle('bots:list', () => bots.listBots())
  ipcMain.handle('bots:upsert', (_e, bot) => {
    bots.upsertBot(bot)
    return bots.listBots()
  })
  ipcMain.handle('bots:delete', (_e, id: string) => bots.deleteBot(id))
  ipcMain.handle('bots:getMessages', (_e, botId: string) => bots.getBotMessages(botId))
  ipcMain.handle('bots:getMemory', (_e, botId: string) => bots.loadBotMemory(botId))
  ipcMain.handle('bots:stop', (_e, botId: string) => bots.stopBot(botId))
  ipcMain.handle('bots:active', () => bots.activeBotSessions())
  ipcMain.on('bots:send', (_e, opts) => {
    bots
      .sendBotMessage({ ...opts, emit: (ev) => emit('bot:event', ev) })
      .catch((err) => {
        appLog(`[bots] 发送链路异常: ${err instanceof Error ? err.stack || err.message : String(err)}`)
        emit('bot:event', { type: 'error', botId: opts?.botId, message: '内部错误，详情见日志' })
      })
  })

  ipcMain.handle('groups:list', () => bots.listGroups())
  ipcMain.handle('groups:create', (_e, name: string, botIds: string[]) => bots.createGroup(name, botIds))
  ipcMain.handle('groups:update', (_e, id: string, patch) => bots.updateGroup(id, patch))
  ipcMain.handle('groups:delete', (_e, id: string) => bots.deleteGroup(id))
  ipcMain.handle('groups:getMessages', (_e, groupId: string) => bots.getGroupMessages(groupId))
  ipcMain.handle('groups:stop', (_e, groupId: string) => bots.stopGroup(groupId))
  ipcMain.on('groups:send', (_e, opts) => {
    bots
      .sendGroupMessage({ ...opts, emit: (ev) => emit('group:event', ev) })
      .catch((err) => {
        appLog(`[groups] 发送链路异常: ${err instanceof Error ? err.stack || err.message : String(err)}`)
        emit('group:event', { type: 'error', groupId: opts?.groupId, message: '内部错误，详情见日志' })
      })
  })

  // Ollama
  ipcMain.handle('ollama:status', () => ollama.ollamaStatus())

  // 生图 / 生视频（ComfyUI）
  ipcMain.handle('comfy:status', () => comfy.comfyStatus())
  ipcMain.handle('comfy:start', () => comfy.startComfy())
  ipcMain.handle('comfy:models', () => comfy.listGenModels())
  ipcMain.handle('gen:list', (_e, kind: 'image' | 'video') => comfy.listGenSessions(kind))
  ipcMain.handle('gen:create', (_e, kind: 'image' | 'video', modelId?: string) =>
    comfy.createGenSession(kind, modelId)
  )
  ipcMain.handle('gen:update', (_e, id: string, patch) => comfy.updateGenSession(id, patch))
  ipcMain.handle('gen:delete', (_e, id: string) => comfy.deleteGenSession(id))
  ipcMain.handle('gen:messages', (_e, id: string) => comfy.getGenMessages(id))
  ipcMain.on('gen:send', (_e, opts) => {
    comfy
      .runGeneration({ ...opts, emit: (ev) => emit('gen:event', ev) })
      .catch((err) => {
        // 前置段抛错不能静默——否则界面永远停在「正在排队」
        console.error('[gen] runGeneration crashed:', err)
        emit('gen:event', { type: 'error', sessionId: opts?.sessionId, message: err instanceof Error ? err.message : String(err) })
        emit('gen:event', { type: 'end', sessionId: opts?.sessionId })
      })
  })
  ipcMain.on('gen:stop', (_e, sessionId: string) => comfy.stopGen(sessionId))
  ipcMain.handle('gen:active', () => comfy.activeGenSessions())

  ipcMain.handle('ollama:deleteModel', (_e, model: string) => ollama.deleteModel(model))
  ipcMain.handle('ollama:install', async (_e, setupPath: string, installDir: string, modelsDir: string) =>
    ollama.installOllama(setupPath, installDir, modelsDir)
  )
  ipcMain.handle('ollama:start', async (_e, installDir: string) => {
    const settings = loadSettings()
    return ollama.startOllamaServe(installDir, settings.ollamaModelsDir)
  })
  ipcMain.handle('ollama:findSetup', (_e, dir: string) => ollama.findSetupFile(dir))
  ipcMain.on('ollama:pull', (_e, model: string) => {
    ollama.pullModel(model, (ev) => emit('ollama:pull-event', ev)).catch((e) => {
      emit('ollama:pull-event', { error: String(e) })
    })
  })
  ipcMain.handle('ollama:openDownloadPage', () => {
    shell.openExternal('https://ollama.com/download/windows')
    return true
  })
}
