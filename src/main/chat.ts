/**
 * 聊天模块 —— 会话管理与对话流程（含联网搜索注入、计划模式、记忆压缩）
 */
import { readJSON, writeJSON, deleteFile, listJSONDir, loadSettings } from './store'
import { Folder, listFoldersIn, createFolderIn, renameFolderIn, removeFolderIn } from './folders'
import { ChatMessage, streamChat, LLMTarget, AbortedError, ToolCall, completeOnce } from './llm'
import { webSearch, refineSearchQuery, SearchResult } from './search'
import { memoryPrefix, maybeCompressSession, learnPreferences, loadSessionMemory } from './memory'
import { resolveRole, federationToolDefs, federationPrompt, execFederationTool, targetLabel } from './federation'
import { mediaToolDefs, execMediaTool, mediaCapabilitiesPrompt } from './comfyui'

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  sources?: SearchResult[]
  ts: number
  model?: string
  images?: string[] // 图片文件名（数据目录 images/）
  video?: string // 视频文件名（数据目录 videos/）
  audio?: string // 音频文件名（数据目录 audio/）
  imageDesc?: string // 识图模型生成的文字描述（联合-识图角色）
  aborted?: boolean // 用户中途点了停止，内容是半截的
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  planMode: boolean
  reasoningLevel?: 'off' | 'low' | 'high'
  target: LLMTarget // 会话绑定的模型
  folderId?: string // 所在文件夹，缺省为未归类（最近）
  archived?: boolean
  pinned?: boolean
  contextTokens?: number // 本会话上下文预算；缺省用设置里的默认值
}

export type ChatFolder = Folder

const sessionsFile = 'chat/sessions.json'
const foldersFile = 'chat/folders.json'

// ---------- 文件夹 ----------

export function listFolders(): ChatFolder[] {
  return listFoldersIn(foldersFile)
}

export function createFolder(name: string): ChatFolder {
  return createFolderIn(foldersFile, name)
}

export function renameFolder(id: string, name: string): ChatFolder {
  return renameFolderIn(foldersFile, id, name)
}

/** 删除文件夹：其中会话移回未归类，不删除会话本身 */
export function deleteFolder(id: string): void {
  removeFolderIn(foldersFile, id)
  const sessions = listSessions().map((s) => (s.folderId === id ? { ...s, folderId: undefined } : s))
  saveSessions(sessions)
}

export function listSessions(): ChatSession[] {
  return readJSON<ChatSession[]>(sessionsFile, []).sort((a, b) => b.createdAt - a.createdAt)
}

function saveSessions(list: ChatSession[]): void {
  writeJSON(sessionsFile, list)
}

export function createSession(target: LLMTarget, title?: string): ChatSession {
  const s: ChatSession = {
    id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title ?? '新会话',
    createdAt: Date.now(),
    planMode: false,
    target
  }
  const list = listSessions()
  list.push(s)
  saveSessions(list)
  return s
}

export function updateSession(id: string, patch: Partial<ChatSession>): ChatSession {
  const list = listSessions()
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) throw new Error('会话不存在')
  list[i] = { ...list[i], ...patch }
  saveSessions(list)
  return list[i]
}

export function deleteSession(id: string): void {
  // 先取消息，把用户发的图片文件名收齐
  const msgs = getMessages(id)
  saveSessions(listSessions().filter((x) => x.id !== id))
  deleteFile(`chat/${id}.json`)
  // 会话压缩出来的长期记忆，以及会话里发过的图片，都要跟着删干净
  deleteFile(`chat-memory/${id}.json`)
  for (const m of msgs) for (const n of m.images ?? []) deleteFile(`images/${n}`)
}

/** 清理空会话（无任何消息）——旧版本「点新会话即创建」留下的空壳，启动时执行一次 */
export function purgeEmptySessions(): void {
  const list = listSessions()
  const keep = list.filter((s) => getMessages(s.id).length > 0)
  if (keep.length === list.length) return
  saveSessions(keep)
  for (const s of list) {
    if (!keep.some((k) => k.id === s.id)) deleteFile(`chat/${s.id}.json`)
  }
}

export function getMessages(sessionId: string): ChatMsg[] {
  return readJSON<ChatMsg[]>(`chat/${sessionId}.json`, [])
}

function saveMessages(sessionId: string, msgs: ChatMsg[]): void {
  writeJSON(`chat/${sessionId}.json`, msgs)
}

const activeAborts = new Map<string, AbortController>()

export function stopChat(sessionId: string): void {
  activeAborts.get(sessionId)?.abort()
}

/** 正在生成回复的会话。渲染层切换页面后靠它恢复「生成中」状态，否则会以为没在跑而重复发送 */
export function activeChatSessions(): string[] {
  return [...activeAborts.keys()]
}

const PLAN_SUFFIX = `\n\n【计划模式已开启】回答前请先给出分步计划（用「计划：」开头，编号列出步骤），然后明确说明"以上是我的计划，请确认后我再执行"。除非用户确认，不要执行具体操作。`

const TITLE_PROMPT = `你是会话标题生成器。根据用户的问题和 AI 的回答，生成一个 4~12 字的中文标题，概括对话主题（比如「导数极限题求解」「周末火锅计划」）。只输出标题本身，不要引号、句号或其他内容。`

/** 用会话模型生成标题；失败返回 null（调用方回落截断） */
async function generateTitle(target: LLMTarget, userText: string, assistantText: string): Promise<string | null> {
  try {
    const out = await completeOnce(
      target,
      [
        { role: 'system', content: TITLE_PROMPT },
        {
          role: 'user',
          content: `用户：${userText.slice(0, 300)}\n\nAI：${assistantText.slice(0, 500)}`
        }
      ],
      { temperature: 0.3, maxTokens: 30 }
    )
    const title = out.replace(/["'「」\s。.!！?？]/g, '').slice(0, 16).trim()
    return title.length >= 2 ? title : null
  } catch {
    return null
  }
}

export interface ChatSendOptions {
  sessionId: string
  userText: string
  webSearch: boolean
  images?: string[] // 本次随消息发送的图片文件名（数据目录 images/）
  emit: (event: { type: string; [k: string]: unknown }) => void
}

export async function sendChatMessage(opts: ChatSendOptions): Promise<void> {
  const { sessionId, userText, emit } = opts
  // 并行会话隔离：每个事件都带上 sessionId，渲染层按会话分发
  const emitS = (e: { type: string; [k: string]: unknown }): void => emit({ ...e, sessionId })
  const session = listSessions().find((x) => x.id === sessionId)
  if (!session) {
    emitS({ type: 'error', message: '会话不存在', sessionId })
    return
  }
  const msgs = getMessages(sessionId)
  const incomingImages = (opts.images ?? []).filter(Boolean)
  const userMsg: ChatMsg = {
    id: 'm_' + Date.now().toString(36),
    role: 'user',
    content: userText,
    ts: Date.now(),
    images: incomingImages.length ? incomingImages : undefined
  }
  msgs.push(userMsg)
  saveMessages(sessionId, msgs)
  emitS({ type: 'user-saved', message: userMsg })

  const ac = new AbortController()
  activeAborts.set(sessionId, ac)

  // 上下文压缩角色：配置了独立压缩模型时由它代做，否则主模型兼任
  const compressTarget = resolveRole('compress', session.target) ?? session.target

  // 手动压缩指令：「上下文压缩」「压缩记忆」等短句
  if (/^\s*(请|帮我)?\s*(上下文|记忆)?\s*压缩(一下)?(上下文|记忆)?\s*[!！。.？]?\s*$/.test(userText)) {
    await maybeCompressSession(sessionId, msgs, compressTarget, { force: true })
    const mem = loadSessionMemory(sessionId)
    const reply =
      mem.facts.length === 0
        ? '🧹 这段对话还没什么可压缩的旧内容，上下文已经是最省的状态，接着聊就好。'
        : `🧹 上下文已压缩：较早的对话已提炼为 ${mem.facts.length} 条记忆事实继续生效，最近的内容保持原样，上下文占用明显下降。`
    const aid = 'm_' + (Date.now() + 1).toString(36)
    const cur = getMessages(sessionId)
    cur.push({ id: aid, role: 'assistant', content: reply, ts: Date.now(), model: `memory/压缩` })
    saveMessages(sessionId, cur)
    emitS({ type: 'delta', id: aid, text: reply })
    emitS({ type: 'done', id: aid })
    activeAborts.delete(sessionId)
    emitS({ type: 'end' })
    return
  }

  // 联合-识图：配置了独立识图模型时，先由它把图片转成文字描述（主模型无需多模态）
  let imageDesc: string | undefined
  const visionTarget = resolveRole('vision', session.target)
  if (incomingImages.length && visionTarget) {
    emitS({ type: 'status', text: `👁 识图模型 ${targetLabel(visionTarget)} 正在解读图片…` })
    const parts: string[] = []
    for (const name of incomingImages) {
      try {
        const d = await completeOnce(visionTarget, [
          {
            role: 'system',
            content:
              '你是识图助手。请详细描述这张图片的内容（图中的文字、布局、人物、物体、图表数据要点等），描述将提供给另一个 AI 使用。直接输出描述，不要开场白。'
          },
          { role: 'user', content: '请描述这张图片的内容。', images: [name] }
        ])
        parts.push(`【图片 ${name}】\n${d.trim().slice(0, 2000)}`)
      } catch (e) {
        parts.push(`【图片 ${name}】识图失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    imageDesc = parts.join('\n\n')
  }
  if (imageDesc) {
    userMsg.imageDesc = imageDesc
    saveMessages(sessionId, msgs)
  }

  // 联网搜索
  let sources: SearchResult[] = []
  let searchContext = ''
  if (opts.webSearch) {
    emitS({ type: 'status', text: '正在理解要搜什么…' })
    try {
      // 先把口语问题压成关键词再搜：整句直接搜会命中"搜狗/搜狐"这类无关页（实测）
      const q = await refineSearchQuery(userText)
      emitS({ type: 'status', text: `正在联网搜索「${q}」…` })
      sources = await webSearch(q, 6, { refine: false })
      if (sources.length) {
        searchContext =
          '\n\n【联网搜索结果】\n' +
          sources.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\n来源: ${r.url}`).join('\n\n')
        emitS({ type: 'sources', sources })
      } else {
        emitS({ type: 'status', text: '没搜到相关结果，直接回答（建议换个更具体的说法）' })
      }
    } catch (e) {
      emitS({ type: 'status', text: `搜索失败: ${e instanceof Error ? e.message : e}，改为直接回答` })
    }
  }

  // 组装上下文（记忆 + 计划模式 + 联合）；已压缩进记忆的旧消息不再重复发给模型
  const st = loadSettings()
  const budget = session.contextTokens ?? st.chatTokens ?? st.memoryTokens ?? 32768
  const memState = loadSessionMemory(sessionId)
  const from = Math.min(memState.compressedUpTo, Math.max(msgs.length - 1, 0))
  const prefix = memoryPrefix(sessionId)
  const systemParts = ['你是「小镜」，一个简洁、真诚、有能力的中文 AI 助手。用 Markdown 回答。']
  if (prefix) systemParts.push(prefix)
  if (session.planMode) systemParts.push(PLAN_SUFFIX)
  const fedPrompt = federationPrompt(session.target)
  if (fedPrompt) systemParts.push(fedPrompt)
  // 本地生成能力认知（何时该用 / 不该用）
  const mediaPrompt = mediaCapabilitiesPrompt()
  if (mediaPrompt) systemParts.push(mediaPrompt)

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemParts.join('\n\n') },
    ...msgs.slice(from).map((m) => {
      let content = m.content
      // 历史消息里的图片：优先用已存的识图描述；没有描述且非当前消息时只留标记（不重发图片数据）
      if (m.images?.length) {
        if (m.imageDesc) content += `\n\n【图片内容（识图模型提供）】\n${m.imageDesc}`
        else if (m !== userMsg) content += `\n（本条附带 ${m.images.length} 张图片：${m.images.join('、')}，如需查看请让用户重新发送）`
      }
      if (m === userMsg && incomingImages.length && !imageDesc) {
        // 主模型自己看图（多模态），仅当前消息携带图片数据
        return { role: m.role, content, images: incomingImages } as ChatMessage
      }
      return { role: m.role, content } as ChatMessage
    })
  ]
  if (searchContext) {
    llmMessages[llmMessages.length - 1].content += searchContext
  }

  // 工具组装：联合（委派/云生图）+ 本地生成（生图/生视频/生音乐）
  // 同名 generate_image 本地就绪时本地优先（免费），云端版本让位
  const fedTools = federationToolDefs(session.target)
  const mediaTools = mediaToolDefs() as { function?: { name?: string } }[]
  const localNames = new Set(mediaTools.map((t) => t.function?.name).filter(Boolean) as string[])
  const hasLocalImage = localNames.has('generate_image')
  const allTools = [
    ...fedTools.filter((t: any) => !(hasLocalImage && t.function?.name === 'generate_image')),
    ...mediaTools
  ]

  let assistantText = ''
  let reasoningText = ''
  const collectedImages: string[] = []
  let collectedVideo: string | undefined
  let collectedAudio: string | undefined
  const assistantId = 'm_' + (Date.now() + 1).toString(36)
  let fedUsed = false

  try {
    const maxRounds = allTools.length ? 6 : 1
    for (let round = 0; round < maxRounds; round++) {
      if (ac.signal.aborted) throw new AbortedError('aborted')
      if (round > 0 && assistantText) {
        assistantText += '\n\n'
        emitS({ type: 'delta', id: assistantId, text: '\n\n' })
      }
      emitS({ type: 'status', text: '' })
      let roundText = ''
      let roundError: string | null = null
      let toolCalls: ToolCall[] | undefined
      await streamChat(
        session.target,
        llmMessages,
        {
          onDelta: (t) => {
            assistantText += t
            roundText += t
            emitS({ type: 'delta', id: assistantId, text: t })
          },
          onReasoning: (t) => {
            reasoningText += t
            emitS({ type: 'reasoning', id: assistantId, text: t })
          },
          onToolCalls: (calls) => {
            toolCalls = calls
          },
          onDone: () => {},
          onError: (m) => {
            roundError = m
            if (m !== '__aborted__') emitS({ type: 'error', message: m })
          }
        },
        {
          signal: ac.signal,
          reasoningLevel: session.reasoningLevel ?? 'off',
          numCtx: budget,
          ...(allTools.length ? { tools: allTools as any } : {})
        }
      )
      if (roundError || !toolCalls || toolCalls.length === 0) break
      // 执行工具（本地生成优先分发），结果回填后进入下一轮（主模型验收整合）
      fedUsed = true
      llmMessages.push({ role: 'assistant', content: roundText || '(调用工具)' })
      for (const call of toolCalls) {
        emitS({ type: 'status', text: `⚙ ${call.name === 'generate_image' ? '生成图片' : call.name === 'generate_video' ? '生成视频' : call.name === 'generate_music' ? '生成音乐' : '委派'}…` })
        if (localNames.has(call.name)) {
          const r = await execMediaTool(call, (t) => emitS({ type: 'status', text: t }))
          if (r.fileName && r.kind === 'image') {
            collectedImages.push(r.fileName)
            emitS({ type: 'images', images: [r.fileName] })
          } else if (r.fileName && r.kind === 'video') {
            collectedVideo = r.fileName
            emitS({ type: 'video', video: r.fileName })
          } else if (r.fileName && r.kind === 'audio') {
            collectedAudio = r.fileName
            emitS({ type: 'audio', audio: r.fileName })
          }
          llmMessages.push({ role: 'user', content: `工具 ${call.name} 返回: ${r.result}` })
        } else {
          const r = await execFederationTool(
            call,
            session.target,
            (t) => emitS({ type: 'status', text: t }),
            ac.signal
          )
          if (r.images?.length) {
            collectedImages.push(...r.images)
            emitS({ type: 'images', images: r.images })
          }
          llmMessages.push({ role: 'user', content: `工具 ${call.name} 返回: ${r.result}` })
        }
      }
    }
    // 停止时这里是半截内容：标记出来，界面要能区别于「正常写完」
    const wasAborted = ac.signal.aborted
    emitS({ type: 'done', id: assistantId, aborted: wasAborted })
    // 保存助手消息：一个字都没吐出来就停了 → 不留空消息在历史里（否则下次会当作空的 assistant 轮次发给模型）
    if (assistantText.trim()) {
      const cur = getMessages(sessionId)
      cur.push({
        id: assistantId,
        role: 'assistant',
        content: assistantText,
        reasoning: reasoningText || undefined,
        sources: sources.length ? sources : undefined,
        ts: Date.now(),
        model: `${session.target.providerId}/${session.target.model}` + (fedUsed ? ' · 联合' : ''),
        images: collectedImages.length ? collectedImages : undefined,
        video: collectedVideo,
        audio: collectedAudio,
        aborted: wasAborted || undefined
      })
      saveMessages(sessionId, cur)
    }
    // 自动改标题：用会话模型生成摘要式标题（本地模型做题也能得到合理标题），失败回落截断
    const sess = listSessions().find((x) => x.id === sessionId)
    if (sess && sess.title === '新会话' && assistantText) {
      void generateTitle(session.target, userText, assistantText)
        .then((title) => {
          if (!title) throw new Error('empty')
          updateSession(sessionId, { title })
          emitS({ type: 'session-title', title })
        })
        .catch(() => {
          const fallback = userText.slice(0, 18) || '新会话'
          updateSession(sessionId, { title: fallback })
          emitS({ type: 'session-title', title: fallback })
        })
    }
    // 后台：记忆压缩（超预算 80% 自动触发，压缩角色优先）+ 偏好学习（不阻塞）
    // 失败不影响对话，但不能一点痕迹都不留——否则"记忆怎么没生效"只能靠猜
    maybeCompressSession(sessionId, msgs, compressTarget, { budget }).catch((e) =>
      console.error('[memory] 压缩失败:', e instanceof Error ? e.message : e)
    )
    learnPreferences(llmMessages.slice(1), session.target).catch((e) =>
      console.error('[memory] 偏好学习失败:', e instanceof Error ? e.message : e)
    )
  } catch (err) {
    if (!(err instanceof AbortedError)) {
      emitS({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    activeAborts.delete(sessionId)
    emitS({ type: 'end' })
  }
}
