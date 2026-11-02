/**
 * 数据存储层 —— 隐私总纲的实现：
 * - 所有用户数据为明文 JSON，存放在可自选的数据目录
 * - API 密钥用 Electron safeStorage(DPAPI) 加密，存于 userData（不随数据目录迁移）
 * - 所有写入均为原子写（临时文件 + rename）
 */
import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

let dataDir = ''
const globalDir = () => path.join(app.getPath('userData'), 'config')

export function initDataDir(): string {
  const pointerFile = path.join(globalDir(), 'dataDir.txt')
  try {
    if (fs.existsSync(pointerFile)) {
      const saved = fs.readFileSync(pointerFile, 'utf-8').trim()
      if (saved && fs.existsSync(saved)) dataDir = saved
    }
  } catch { /* ignore */ }
  if (!dataDir) {
    // 默认放 D 盘（不占系统盘）；没有 D 盘才退回文档目录
    dataDir = fs.existsSync('D:/') ? 'D:\\小镜数据' : path.join(app.getPath('documents'), '小镜数据')
  }
  ensureDirs()
  return dataDir
}

export function getDataDir() {
  return dataDir
}

export async function setDataDir(dir: string): Promise<void> {
  if (!path.isAbsolute(dir)) throw new Error('必须是绝对路径')
  // 迁移现有数据
  if (fs.existsSync(dataDir) && dir.toLowerCase() !== dataDir.toLowerCase()) {
    fs.mkdirSync(dir, { recursive: true })
    for (const item of fs.readdirSync(dataDir)) {
      fs.cpSync(path.join(dataDir, item), path.join(dir, item), { recursive: true })
    }
  }
  dataDir = dir
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(globalDir(), { recursive: true })
  fs.writeFileSync(path.join(globalDir(), 'dataDir.txt'), dir, 'utf-8')
  ensureDirs()
}

function ensureDirs() {
  for (const sub of ['chat', 'chat-memory', 'bots', 'bot-chats', 'groups', 'group-chats', 'codex', 'avatars', 'images', 'videos', 'audio', 'gen']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true })
  }
}

export function readJSON<T>(rel: string, fallback: T): T {
  const file = path.join(dataDir, rel)
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

export function writeJSON(rel: string, data: unknown): void {
  const file = path.join(dataDir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

export function deleteFile(rel: string): void {
  const file = path.join(dataDir, rel)
  if (!fs.existsSync(file)) return
  // Windows 上刚写完的文件、或被 Defender/索引临时占用的文件，删除会 EBUSY/EPERM。
  // 以前一次失败就抛出去，调用方 catch 一吞 → 索引删了文件还在，变成谁也看不到的孤儿。
  fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 60 })
}

/** 删除目录里不在 keep 集合中的 json（删除会话/机器人时文件被占用留下的残留）。
 *  注意：keep 为空时直接跳过——索引读坏了宁可不动，也不能把用户数据清空。 */
export function pruneOrphanFiles(rel: string, keep: Set<string>): number {
  if (!keep.size) return 0
  const dir = path.join(dataDir, rel)
  if (!fs.existsSync(dir)) return 0
  let n = 0
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const base = f.replace(/\.memory\.json$/, '').replace(/\.json$/, '')
    if (keep.has(base)) continue
    try {
      deleteFile(`${rel}/${f}`)
      n++
    } catch {
      /* 删不掉下次启动再试 */
    }
  }
  return n
}

export function listJSONDir(rel: string): string[] {
  const dir = path.join(dataDir, rel)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
}

// ---------- 应用设置 ----------

export interface ProviderConfig {
  id: string // 内置: openai / anthropic / deepseek / glm / kimi / openrouter / ollama / 自定义id
  name: string
  baseUrl: string
  apiType: 'openai' | 'anthropic'
  apiKeyEncrypted?: string // base64(DPAPI)
  hasKey: boolean
  models: string[]
}

/** 联合模式的一个角色配置（providerId 为空 = 主模型兼任 / 不启用） */
export interface FedRoleConfig {
  providerId: string
  model: string
}

/**
 * 联合模式：聊天 / Codex 中的当前模型是「主模型」，
 * 简单任务与专项能力（生图等）可交给其他辅助模型，主模型负责规划、说明与验收。
 */
export interface FederationSettings {
  enabled: boolean
  subAgent?: FedRoleConfig // 辅助代理：接收主模型委派的简单子任务
  vision?: FedRoleConfig // 识图：主模型不便看图时，先由它把图片转成文字描述
  compress?: FedRoleConfig // 上下文压缩：记忆压缩交给更便宜的模型
  imageGen?: FedRoleConfig // 生图：文生图（走 /images/generations）
  videoGen?: FedRoleConfig // 生视频：预留角色（暂未接入调用）
}

export interface AppSettings {
  providers: ProviderConfig[]
  defaultProviderId: string
  defaultModel: string
  searchProvider: 'duckduckgo' | 'tavily' | 'bocha'
  tavilyKeyEncrypted?: string
  bochaKeyEncrypted?: string
  ollamaDir: string
  ollamaModelsDir: string
  memoryTokens: number // 单会话上下文预算（token），超过自动压缩旧消息为关键事实（旧字段，作为三档的公共回落值）
  chatTokens?: number // 聊天默认上下文预算
  codexTokens?: number // Codex 任务默认上下文预算
  botsTokens?: number // 机器人单聊上下文预算
  theme: 'system' | 'light' | 'dark'
  federation?: FederationSettings
  comfyDir?: string // ComfyUI 便携版根目录（含 run_nvidia_gpu.bat）
  comfyPort?: number // ComfyUI API 端口
  autoStartLocal?: boolean // 启动小镜时自动拉起本地服务（Ollama / ComfyUI），默认 true
  stopLocalOnQuit?: boolean // 退出小镜时关掉"由小镜拉起"的本地服务，默认 true
}

const BUILTIN_PROVIDERS: Omit<ProviderConfig, 'hasKey'>[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiType: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiType: 'anthropic', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiType: 'openai', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'glm', name: 'GLM (Z.AI)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiType: 'openai', models: ['glm-4.6', 'glm-4.5-air'] },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiType: 'openai', models: ['kimi-k2-0905-preview', 'moonshot-v1-8k'] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiType: 'openai', models: [] },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', apiType: 'openai', models: [] }
]

const SETTINGS_FILE = 'settings.json'

export function loadSettings(): AppSettings {
  const s = readJSON<AppSettings>(SETTINGS_FILE, null as unknown as AppSettings)
  if (!s) {
    return {
      providers: BUILTIN_PROVIDERS.map((p) => ({ ...p, hasKey: false })),
      defaultProviderId: 'glm',
      defaultModel: 'glm-4.6',
      searchProvider: 'duckduckgo',
      ollamaDir: 'E:\\ollama',
      ollamaModelsDir: 'E:\\ollama数据和模型',
      memoryTokens: 32768,
      chatTokens: 32768,
      codexTokens: 32768,
      botsTokens: 32768,
      theme: 'system'
    }
  }
  // 补齐新增内置供应商
  for (const b of BUILTIN_PROVIDERS) {
    if (!s.providers.find((p) => p.id === b.id)) s.providers.push({ ...b, hasKey: false })
  }
  if (!s.memoryTokens) s.memoryTokens = 32768
  // 三档预算缺省回落到旧字段（老配置升级时继承原值）
  if (!s.chatTokens) s.chatTokens = s.memoryTokens
  if (!s.codexTokens) s.codexTokens = s.memoryTokens
  if (!s.botsTokens) s.botsTokens = s.memoryTokens
  return s
}

export function saveSettings(s: AppSettings): void {
  writeJSON(SETTINGS_FILE, s)
}

// ---------- 密钥加解密 ----------

export function encryptSecret(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  return Buffer.from(plain, 'utf-8').toString('base64') // 不可加密环境兜底（仍不推荐）
}

export function decryptSecret(enc: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
    return Buffer.from(enc, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

export function setProviderKey(providerId: string, key: string): void {
  const s = loadSettings()
  const p = s.providers.find((x) => x.id === providerId)
  if (!p) throw new Error('供应商不存在')
  p.apiKeyEncrypted = key ? encryptSecret(key) : undefined
  p.hasKey = !!key
  saveSettings(s)
}

export function getProviderKey(providerId: string): string {
  const s = loadSettings()
  const p = s.providers.find((x) => x.id === providerId)
  if (!p?.apiKeyEncrypted) return ''
  return decryptSecret(p.apiKeyEncrypted)
}

export function setSearchKey(which: 'tavily' | 'bocha', key: string): void {
  const s = loadSettings()
  if (which === 'tavily') s.tavilyKeyEncrypted = key ? encryptSecret(key) : undefined
  else s.bochaKeyEncrypted = key ? encryptSecret(key) : undefined
  saveSettings(s)
}

export function getSearchKey(which: 'tavily' | 'bocha'): string {
  const s = loadSettings()
  const enc = which === 'tavily' ? s.tavilyKeyEncrypted : s.bochaKeyEncrypted
  return enc ? decryptSecret(enc) : ''
}

// ---------- 导出 / 删除 ----------

export function exportAllData(): { dir: string; files: number; skipped: string[] } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = path.join(path.dirname(dataDir), `小镜导出-${stamp}`)
  // 原来用 fs.cpSync：本机实测它会让主进程以 0xC0000409（STATUS_STACK_BUFFER_OVERRUN）
  // 直接 crash，用户点「导出全部数据」只能看到一句 "EPERM, 函数不正确"，备份根本做不出来。
  // 改成逐个文件复制（底层 CopyFileEx，同样的目录 PowerShell 156ms 就拷完）。
  const skipped: string[] = []
  let files = 0
  const walk = (src: string, dst: string): void => {
    fs.mkdirSync(dst, { recursive: true })
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name)
      const d = path.join(dst, ent.name)
      if (ent.isDirectory()) {
        walk(s, d)
      } else if (ent.isFile()) {
        try {
          fs.copyFileSync(s, d)
          files++
        } catch {
          // 单个文件被占用（如正在写的 app.log）不该毁掉整次导出
          skipped.push(path.relative(dataDir, s))
        }
      }
    }
  }
  walk(dataDir, out)
  return { dir: out, files, skipped }
}

export function wipeAllData(): void {
  fs.rmSync(dataDir, { recursive: true, force: true })
  ensureDirs()
}
