/**
 * Codex 模块 —— 编程 agent：选工作目录，可读写文件、执行命令（默认需批准）、联网搜索。
 * 支持计划模式：先出计划，用户批准后继续执行。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { ChatMessage, streamChat, ToolCall, LLMTarget, AbortedError, completeOnce } from './llm'
import { webSearch, SearchResult } from './search'

export interface CodexMsg {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolDetail?: string
  ts: number
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
  folderId?: string // 所在文件夹，缺省为未归类（最近）
  archived?: boolean
  pinned?: boolean
  contextTokens?: number // 本任务上下文预算；缺省用设置里的默认值
  summary?: string // 已压缩的早期对话摘要（不占 history）
  history: { role: 'user' | 'assistant'; content: string }[]
}

const sessionsFile = 'codex/sessions.json'
const foldersFile = 'codex/folders.json'

// ---------- 任务文件夹 ----------

export function listCodexFolders(): Folder[] {
  return listFoldersIn(foldersFile)
}

export function createCodexFolder(name: string): Folder {
  return createFolderIn(foldersFile, name)
}

export function renameCodexFolder(id: string, name: string): Folder {
  return renameFolderIn(foldersFile, id, name)
}

/** 删除文件夹：其中任务移回未分类，不删除任务本身 */
export function deleteCodexFolder(id: string): void {
  removeFolderIn(foldersFile, id)
  const sessions = loadSessions().map((s) => (s.folderId === id ? { ...s, folderId: undefined } : s))
  saveSessions(sessions)
}

function loadSessions(): CodexSession[] {
  return readJSON<CodexSession[]>(sessionsFile, [])
}
function saveSessions(list: CodexSession[]): void {
  writeJSON(sessionsFile, list)
}

import { readJSON, writeJSON, loadSettings } from './store'
import { Folder, listFoldersIn, createFolderIn, renameFolderIn, removeFolderIn } from './folders'
import { estimateTokens } from './memory'
import { resolveRole, federationToolDefs, federationPrompt, execFederationTool } from './federation'
import { mediaToolDefs, execMediaTool, mediaCapabilitiesPrompt, listGenModels } from './comfyui'

export function listCodexSessions(): CodexSession[] {
  return loadSessions().sort((a, b) => b.createdAt - a.createdAt)
}

export function createCodexSession(workdir: string, target: LLMTarget): CodexSession {
  // 未选工作区时落到默认工作区（非系统盘优先），并确保目录存在
  let dir = (workdir ?? '').trim()
  if (!dir) {
    dir = fs.existsSync('D:/')
      ? 'D:\\小镜codex默认'
      : path.join(os.homedir(), 'Documents', '小镜codex默认')
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch { /* 目录创建失败时由工具层报错 */ }
  const s: CodexSession = {
    id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workdir: dir,
    title: path.basename(dir) || '新任务',
    createdAt: Date.now(),
    planMode: false,
    autoApprove: false,
    target,
    history: []
  }
  const list = loadSessions()
  list.push(s)
  saveSessions(list)
  return s
}

export function updateCodexSession(id: string, patch: Partial<CodexSession>): CodexSession {
  const list = loadSessions()
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) throw new Error('任务不存在')
  list[i] = { ...list[i], ...patch }
  saveSessions(list)
  return list[i]
}

export function deleteCodexSession(id: string): void {
  saveSessions(loadSessions().filter((x) => x.id !== id))
}

// ---------- 工具定义 ----------

const TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取文件内容（UTF-8 文本，最多 4000 字符），只读。可用相对工作目录的路径，也可用本机任意位置的绝对路径',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: '相对工作目录的路径，或本机绝对路径' } },
        required: ['file']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '写入/创建工作目录内的文件（覆盖式写入完整内容）。只能写工作目录内部，工作区外一律拒绝',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '相对工作目录的路径' },
          content: { type: 'string', description: '完整文件内容' }
        },
        required: ['file', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        '列出目录下的文件与子目录，只读。可用相对工作目录的路径（"." 表示工作目录根），也可用本机任意位置的绝对路径',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: '相对工作目录的路径，或本机绝对路径' } },
        required: ['dir']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在工作目录执行一条 shell 命令（默认 60 秒超时，返回 stdout/stderr 前 4000 字符）',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索，返回带来源的结果列表',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  }
]

function safeJoin(workdir: string, rel: string): string {
  const full = path.resolve(workdir, rel)
  const norm = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')
  const work = norm(workdir)
  // 不能只做 startsWith 前缀匹配，否则 D:\work2 会被误认为 D:\work 内部
  if (norm(full) !== work && !norm(full).startsWith(work + path.sep)) {
    throw new Error('路径越出工作目录，已拒绝')
  }
  return full
}

function toolResultText(r: { ok: boolean; output: string }): string {
  return JSON.stringify(r)
}

/** 工具卡片显示用参数：只保留可读的定位字段，并把相对路径解析成绝对路径。
 *  （原来直接截断 300 字符，参数一长 JSON 就被截断，渲染层解析失败只能显示半截原文；
 *   而且写入卡片显示的是模型给的相对路径，容易让人以为写到别处去了） */
function displayArgs(session: CodexSession, raw: string): string {
  let j: any
  try {
    j = JSON.parse(raw || '{}')
  } catch {
    return raw.slice(0, 300)
  }
  const out: Record<string, string> = {}
  for (const k of ['file', 'dir'] as const) {
    if (typeof j?.[k] === 'string' && j[k]) {
      out[k] = path.isAbsolute(j[k]) ? j[k] : path.resolve(session.workdir, j[k])
    }
  }
  if (typeof j?.command === 'string' && j.command) out.command = j.command.slice(0, 200)
  if (typeof j?.query === 'string' && j.query) out.query = j.query.slice(0, 120)
  if (typeof j?.prompt === 'string' && j.prompt) out.prompt = j.prompt.slice(0, 120)
  if (typeof j?.duration === 'number') out.duration = String(j.duration)
  return JSON.stringify(Object.keys(out).length ? out : { args: raw.slice(0, 200) })
}

async function executeTool(
  session: CodexSession,
  call: ToolCall,
  requestApproval: (detail: string) => Promise<boolean>,
  signal?: AbortSignal
): Promise<string> {
  let args: any = {}
  try { args = JSON.parse(call.arguments || '{}') } catch { return toolResultText({ ok: false, output: '参数解析失败' }) }
  // 只读模式：改动类工具直接拒绝，不进入审批
  if (session.readonly && (call.name === 'write_file' || call.name === 'run_command')) {
    return toolResultText({ ok: false, output: '当前任务为只读模式，该操作已被拒绝' })
  }
  try {
    switch (call.name) {
      case 'read_file': {
        const full = path.resolve(session.workdir, args.file)
        const content = fs.readFileSync(full, 'utf-8')
        return toolResultText({ ok: true, output: content.slice(0, 4000) })
      }
      case 'write_file': {
        const full = safeJoin(session.workdir, args.file)
        const approved =
          session.autoApprove || (await requestApproval(`写入文件 ${full}（${(args.content ?? '').length} 字符）`))
        if (!approved) return toolResultText({ ok: false, output: '用户拒绝写入' })
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, String(args.content ?? ''), 'utf-8')
        return toolResultText({ ok: true, output: `已写入 ${full}` })
      }
      case 'list_dir': {
        const full = path.resolve(session.workdir, args.dir ?? '.')
        const items = fs.readdirSync(full, { withFileTypes: true }).slice(0, 200)
        return toolResultText({
          ok: true,
          output: `目录 ${full}:\n` + (items.map((d) => (d.isDirectory() ? '[目录] ' : '') + d.name).join('\n') || '(空)')
        })
      }
      case 'run_command': {
        const approved = session.autoApprove || (await requestApproval(`执行命令: ${args.command}`))
        if (!approved) return toolResultText({ ok: false, output: '用户拒绝执行' })
        return toolResultText(await runShell(session.workdir, String(args.command)))
      }
      case 'web_search': {
        // 工具入参已经是模型写好的关键词，不用再让模型改写一遍（省一次调用，也避免改写把关键词改坏）
        const results: SearchResult[] = await webSearch(String(args.query), 6, { refine: false })
        return toolResultText({
          ok: true,
          output: results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\n${r.url}`).join('\n') || '无结果'
        })
      }
      case 'delegate_task': {
        // 联合工具：委派子任务；内部自带能力校验（不可用时返回明确错误）
        const r = await execFederationTool(call, session.target, () => {}, signal)
        return toolResultText({ ok: true, output: r.result })
      }
      case 'generate_image':
      case 'generate_video':
      case 'generate_music': {
        // 本地生成优先（免费）；generate_image 在本地不可用时回落云端联合
        const localReady = listGenModels().some(
          (m) => m.ready && (call.name === 'generate_image' ? m.kind === 'image' : call.name === 'generate_video' ? m.kind === 'video' : m.kind === 'audio')
        )
        if (localReady) {
          const r = await execMediaTool(call)
          let output = r.result
          // 图片在 Codex 里用 Markdown 内嵌展示（渲染层支持 xjfile 图片）
          if (r.fileName && r.kind === 'image') {
            output += `\n![生成图片](xjfile://img/${r.fileName})`
          } else if (r.fileName && r.kind === 'video') {
            output += `\n视频已保存：${r.fileName}（小镜数据 videos/ 目录，可打开查看）`
          } else if (r.fileName && r.kind === 'audio') {
            output += `\n音频已保存：${r.fileName}（小镜数据 audio/ 目录）`
          }
          return toolResultText({ ok: true, output })
        }
        if (call.name === 'generate_image') {
          const r = await execFederationTool(call, session.target, () => {}, signal)
          return toolResultText({ ok: true, output: r.result })
        }
        return toolResultText({ ok: false, output: '本地生成模型文件未就绪，无法生成' })
      }
      default:
        return toolResultText({ ok: false, output: `未知工具 ${call.name}` })
    }
  } catch (e) {
    return toolResultText({ ok: false, output: e instanceof Error ? e.message : String(e) })
  }
}

function runShell(workdir: string, command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', command], { cwd: workdir, windowsHide: true })
    let out = ''
    const timer = setTimeout(() => child.kill(), 60000)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: out.slice(0, 4000) || `(退出码 ${code})` })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, output: e.message })
    })
  })
}

// ---------- 上下文压缩（Codex 任务） ----------

const CODEX_COMPRESS_PROMPT = `你是任务记忆压缩器。请把以下编程任务的执行对话压缩成一段摘要（保留：任务目标、已完成步骤、关键文件路径与改动、重要决定、未完成事项），500 字以内，纯文本输出。`

/** 任务当前上下文占用（摘要 + 历史对话） */
function codexUsedTokens(session: CodexSession): number {
  return (
    estimateTokens(session.summary ?? '') +
    session.history.reduce((n, h) => n + estimateTokens(h.content), 0)
  )
}

/** 把 history 较旧的一半压缩进 summary；force = 用户主动要求。返回是否压缩过 */
async function compressCodexHistory(session: CodexSession, target: LLMTarget, force: boolean): Promise<boolean> {
  const budget = session.contextTokens ?? loadSettings().codexTokens ?? loadSettings().memoryTokens ?? 32768
  if (!force && codexUsedTokens(session) < budget * 0.8) return false
  if (session.history.length === 0) return false
  const chunkCount = Math.max(1, Math.floor(session.history.length / 2))
  const chunk = session.history.slice(0, chunkCount)
  const text = chunk.map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content.slice(0, 1500)}`).join('\n')
  try {
    const out = await completeOnce(target, [
      { role: 'system', content: CODEX_COMPRESS_PROMPT },
      {
        role: 'user',
        content: (session.summary ? `已有摘要：\n${session.summary}\n\n新增对话：\n` : '') + text
      }
    ])
    session.summary = ((session.summary ? session.summary + '\n' : '') + out.trim()).slice(-2000)
  } catch {
    return false // 压缩失败不影响主流程
  }
  session.history = session.history.slice(chunkCount)
  return true
}

// ---------- Agent 循环 ----------

const activeAborts = new Map<string, AbortController>()

/** 正在执行的任务（切页回来恢复状态用） */
export function activeCodexSessions(): string[] {
  return [...activeAborts.keys()]
}

export function stopCodex(sessionId: string): void {
  activeAborts.get(sessionId)?.abort()
}

export interface CodexSendOptions {
  sessionId: string
  userText: string
  emit: (event: { type: string; [k: string]: unknown }) => void
}


const CODEX_TITLE_PROMPT =
  '你是任务标题生成器。根据用户的编程任务指令，生成一个 4~12 字的中文标题，概括这个任务要做什么（比如「修复登录超时BUG」「爬取天气数据脚本」「重构缓存模块」）。只输出标题本身，不要引号、句号或其他内容。'

/** 用任务模型从指令生成短标题；失败回落指令截断 */
async function generateCodexTitle(target: LLMTarget, userText: string): Promise<string> {
  try {
    const out = await completeOnce(
      target,
      [
        { role: 'system', content: CODEX_TITLE_PROMPT },
        { role: 'user', content: userText.slice(0, 300) }
      ],
      { temperature: 0.3, maxTokens: 30 }
    )
    const title = out.replace(/["'「」\s。.!！?？]/g, '').slice(0, 16).trim()
    if (title.length >= 2) return title
  } catch { /* 回落 */ }
  return userText.replace(/\s+/g, ' ').slice(0, 18).trim()
}

export async function runCodexTask(opts: CodexSendOptions): Promise<void> {
  const { sessionId, emit } = opts
  // 并行任务隔离：每个事件都带上 sessionId
  const emitS = (e: { type: string; [k: string]: unknown }): void => emit({ ...e, sessionId })
  const session = loadSessions().find((x) => x.id === sessionId)
  if (!session) {
    emitS({ type: 'error', message: '任务不存在' })
    return
  }
  const ac = new AbortController()
  activeAborts.set(sessionId, ac)

  const budget = session.contextTokens ?? loadSettings().codexTokens ?? loadSettings().memoryTokens ?? 32768

  // 手动压缩指令（「上下文压缩」等短句）：不进历史，直接压缩并回执
  if (/^\s*(请|帮我)?\s*(上下文|记忆)?\s*压缩(一下)?(上下文|记忆)?\s*[!！。.？]?\s*$/.test(opts.userText)) {
    emitS({ type: 'user-saved', content: opts.userText })
    await compressCodexHistory(session, resolveRole('compress', session.target) ?? session.target, true)
    updateCodexSession(sessionId, { history: session.history, summary: session.summary })
    const reply = `🧹 任务上下文已压缩：早期执行过程已提炼为摘要继续生效（摘要约 ${estimateTokens(session.summary ?? '')} 标记），最近 ${session.history.length} 条对话保持原样。`
    emitS({ type: 'delta', text: reply })
    emitS({ type: 'done' })
    return
  }

  // 自动压缩：用量超预算 80% 时把旧对话压成摘要（压缩角色优先，否则主模型兼任）
  if (codexUsedTokens(session) > budget * 0.8) {
    await compressCodexHistory(session, resolveRole('compress', session.target) ?? session.target, false)
    updateCodexSession(sessionId, { history: session.history, summary: session.summary })
  }

  session.history.push({ role: 'user', content: opts.userText })
  emitS({ type: 'user-saved', content: opts.userText })

  // 首条消息后自动起任务标题：目录名无信息量，不好定位；用户手动改过名（≠目录名）则不覆盖
  if (session.title === path.basename(session.workdir)) {
    void generateCodexTitle(session.target, opts.userText)
      .then((title) => {
        updateCodexSession(sessionId, { title })
        emitS({ type: 'session-title', title })
      })
      .catch(() => {})
  }

  const systemParts = [
    '你是「小镜 Codex」，一个严谨的编程 agent，在用户的指定工作目录中完成任务。',
    '规则：1) 动手修改前先用 list_dir / read_file 了解现状；2) 修改文件前尽量阅读原文件；3) 写代码要完整可运行；4) 完成后总结改动。',
    '【权限规则——读写分离，必须遵守】',
    '1) 写入/修改/删除：只能发生在工作目录内。write_file 写工作区外会被直接拒绝；也严禁通过 run_command 修改、移动或删除工作目录之外的任何文件。',
    '2) 读取：不受工作目录限制。read_file / list_dir 可以用本机任意位置的绝对路径（如 C:\\Users\\…\\Desktop）查看资料，也可以用相对工作目录的路径；一律只读，不得改动读到的内容。',
    '3) 涉及文件操作的回复，一律给出完整绝对路径，不得笼统说"桌面"等相对说法。',
    `当前工作目录（写入边界）: ${session.workdir}`
  ]
  if (session.planMode) {
    systemParts.push(
      '【计划模式】这一轮先只输出分步计划（编号列表），不要调用任何工具、不要动手执行。用户批准后才开始执行。'
    )
  }
  const fedPrompt = federationPrompt(session.target)
  if (fedPrompt) systemParts.push(fedPrompt)
  // 本地生成能力认知（何时该用 / 不该用）
  const mediaPrompt = mediaCapabilitiesPrompt()
  if (mediaPrompt) systemParts.push(mediaPrompt)
  // 工具组装：基础 + 联合 + 本地生成；同名 generate_image 本地就绪时本地优先
  const fedDefs = federationToolDefs(session.target)
  const mediaDefs = mediaToolDefs() as { function?: { name?: string } }[]
  const localNames = new Set(mediaDefs.map((t) => t.function?.name).filter(Boolean) as string[])
  const hasLocalImage = localNames.has('generate_image')
  const allTools: unknown[] = [
    ...TOOLS,
    ...fedDefs.filter((t: any) => !(hasLocalImage && t.function?.name === 'generate_image')),
    ...mediaDefs
  ]

  const messages: ChatMessage[] = [
    { role: 'system', content: systemParts.join('\n') },
    ...(session.summary
      ? [{ role: 'user' as const, content: `【早期执行摘要】（更早的对话已压缩为此摘要）\n${session.summary}` }]
      : []),
    ...session.history.map((h) => ({ role: h.role, content: h.content } as ChatMessage))
  ]

  try {
    // 计划模式：第一轮不给工具，模型没法"边说计划边动手"，计划必须等用户批准后才放开工具
    let planPending = session.planMode
    for (let round = 0; round < 20; round++) {
      if (ac.signal.aborted) throw new AbortedError('aborted')
      let assistantText = ''
      let toolCalls: ToolCall[] | undefined
      let planBuf = ''
      await streamChat(
        session.target,
        messages,
        {
          onDelta: (t) => {
            assistantText += t
            // 计划轮先缓冲：批准前不闪给用户，批准后由下面一次性发出（干净的分步计划）
            if (planPending) planBuf += t
            else emitS({ type: 'delta', text: t })
          },
          onToolCalls: (calls) => {
            toolCalls = calls
          },
          onDone: () => {
            if (!planPending) emitS({ type: 'done' })
          },
          onError: (m) => emitS({ type: 'error', message: m })
        },
        {
          signal: ac.signal,
          tools: planPending ? undefined : (allTools as any),
          temperature: 0.2,
          reasoningLevel: session.reasoningLevel ?? 'off',
          numCtx: budget
        }
      )

      if (planPending) {
        const planText = (planBuf || assistantText).trim()
        if (!planText) break
        emitS({ type: 'delta', text: planText })
        emitS({ type: 'done' })
        session.history.push({ role: 'assistant', content: planText })
        messages.push({ role: 'assistant', content: planText })
        const approved = await waitApproval(emit, sessionId, '计划确认：请查看上方计划')
        if (approved) {
          planPending = false
          session.history.push({ role: 'user', content: '已批准计划，开始执行。' })
          messages.push({ role: 'user', content: '已批准计划，开始执行。' })
        } else {
          session.history.push({ role: 'user', content: '用户拒绝了计划，请按反馈调整后重新给一份计划。' })
          messages.push({ role: 'user', content: '用户拒绝了计划，请按反馈调整后重新给一份计划。' })
        }
        continue
      }

      if (!toolCalls && !assistantText) {
        // onError 已经发过；可能无输出
        break
      }
      if (assistantText.trim()) {
        session.history.push({ role: 'assistant', content: assistantText })
        messages.push({ role: 'assistant', content: assistantText })
      }
      if (!toolCalls || toolCalls.length === 0) break

      messages.push({ role: 'assistant', content: assistantText || '(调用工具)' })
      for (const call of toolCalls) {
        emitS({ type: 'tool-start', name: call.name, detail: displayArgs(session, call.arguments) })
        const result = await executeTool(
          session,
          call,
          (detail) => waitApproval(emit, sessionId, detail),
          ac.signal
        )
        emitS({ type: 'tool-result', name: call.name, result: result.slice(0, 600) })
        messages.push({ role: 'user', content: `工具 ${call.name} 返回: ${result}` })
      }
    }
    updateCodexSession(sessionId, { history: session.history })
  } catch (err) {
    if (!(err instanceof AbortedError)) {
      emitS({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    activeAborts.delete(sessionId)
    emitS({ type: 'end' })
  }
}

// ---------- 审批 ----------

const pendingApprovals = new Map<string, (approved: boolean) => void>()
let approvalSeq = 0

function waitApproval(emit: (e: any) => void, sessionId: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    const approvalId = `ap_${++approvalSeq}_${Date.now().toString(36)}`
    pendingApprovals.set(approvalId, resolve)
    emit({ type: 'approval', approvalId, sessionId, detail })
    // 90 秒无人响应视为拒绝，避免 agent 卡死
    setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId)
        resolve(false)
      }
    }, 90000)
  })
}

export function resolveApproval(approvalId: string, approved: boolean): void {
  const fn = pendingApprovals.get(approvalId)
  if (fn) {
    pendingApprovals.delete(approvalId)
    fn(approved)
  }
}
