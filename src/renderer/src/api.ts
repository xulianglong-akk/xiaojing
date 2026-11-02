import type { Api } from '../../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  apiType: 'openai' | 'anthropic'
  hasKey: boolean
  models: string[]
}

export interface AppSettings {
  providers: ProviderConfig[]
  defaultProviderId: string
  defaultModel: string
  searchProvider: 'duckduckgo' | 'tavily' | 'bocha'
  ollamaDir: string
  ollamaModelsDir: string
  memoryTokens: number
  chatTokens?: number
  codexTokens?: number
  botsTokens?: number
  theme: 'system' | 'light' | 'dark'
  skin?: string // 皮肤 id（styles.css 里的 data-skin；缺省 light）
  federation?: FederationSettings
  comfyDir?: string
  comfyPort?: number
  autoStartLocal?: boolean // 启动时自动拉起本地服务（默认 true）
  stopLocalOnQuit?: boolean // 退出时关闭由小镜拉起的本地服务（默认 true）
}

// ---------- 生图 / 生视频（ComfyUI） ----------

export interface GenParams {
  width: number
  height: number
  seed: number
  duration: number
}

export interface GenModelInfo {
  id: string
  name: string
  kind: 'image' | 'video' | 'audio'
  desc: string
  files: string[]
  defaults: Partial<GenParams>
  ready: boolean
  missing: string[]
}

export interface GenSession {
  id: string
  kind: 'image' | 'video' | 'audio'
  title: string
  createdAt: number
  modelId?: string
}

export interface GenMsg {
  id: string
  role: 'user' | 'result'
  prompt: string
  modelId?: string
  params?: GenParams
  images?: string[]
  video?: string
  audio?: string
  meta?: string
  error?: string
  ts: number
}

/** 联合模式角色配置（providerId 为空 = 主模型兼任 / 不启用） */
export interface FedRoleConfig {
  providerId: string
  model: string
}

export interface FederationSettings {
  enabled: boolean
  subAgent?: FedRoleConfig
  vision?: FedRoleConfig
  compress?: FedRoleConfig
  imageGen?: FedRoleConfig
  videoGen?: FedRoleConfig
}

export interface LLMTarget {
  providerId: string
  model: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  planMode: boolean
  reasoningLevel?: 'off' | 'low' | 'high'
  target: LLMTarget
  folderId?: string
  archived?: boolean
  pinned?: boolean
  contextTokens?: number
}

export interface ChatFolder {
  id: string
  name: string
  createdAt: number
}

export interface CategoryStat {
  key: string
  label: string
  size: number
  files: number
  detail: string
}

export interface DataStats {
  totalSize: number
  categories: CategoryStat[]
  activity: number[]
  facts: number
  updatedAt: number
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  sources?: SearchResult[]
  ts: number
  model?: string
  images?: string[]
  imageDesc?: string
  video?: string
  audio?: string
  aborted?: boolean
  error?: string
}

export interface CodexSession {
  id: string
  workdir: string
  title: string
  createdAt: number
  planMode: boolean
  autoApprove: boolean
  readonly?: boolean
  reasoningLevel?: 'off' | 'low' | 'high'
  target: LLMTarget
  folderId?: string
  archived?: boolean
  pinned?: boolean
  contextTokens?: number
  summary?: string
  history?: { role: 'user' | 'assistant'; content: string }[]
}

export interface Bot {
  id: string
  name: string
  avatar: string
  persona: string
  target: LLMTarget
  createdAt: number
  preset?: boolean // 官方拟人形象预设 bot（列表加徽章）
}

export interface BotMsg {
  id: string
  sender: 'user' | 'bot'
  botId?: string
  content: string
  images?: string[]
  video?: string
  audio?: string
  ts: number
}

export interface Group {
  id: string
  name: string
  botIds: string[]
  createdAt: number
}
