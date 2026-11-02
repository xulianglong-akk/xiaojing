/**
 * 机器人模块 —— 拟人化长期 AI 伙伴：
 * - 每个 bot 有独立人格设定与长期记忆，跨会话持续
 * - 支持单聊与群聊（@指定应答 / 自动轮流）
 */
import { readJSON, writeJSON, deleteFile, loadSettings } from './store'
import { ChatMessage, streamChat, LLMTarget, AbortedError, ToolCall } from './llm'
import { loadGlobalMemory, estimateTokens } from './memory'
import { mediaToolDefs, execMediaTool, mediaCapabilitiesPrompt } from './comfyui'

export interface Bot {
  id: string
  name: string
  avatar: string // emoji
  persona: string // 人格设定
  target: LLMTarget
  createdAt: number
  preset?: boolean // 官方拟人形象预设 bot（列表加徽章）
}

export interface BotMsg {
  id: string
  sender: 'user' | 'bot'
  botId?: string
  content: string
  images?: string[] // 本地生成的图片（images/）
  video?: string
  audio?: string
  ts: number
}

export interface Group {
  id: string
  name: string
  botIds: string[]
  rotationIndex: number
  createdAt: number
}

const botsFile = 'bots/bots.json'
const groupsFile = 'groups/groups.json'

export function listBots(): Bot[] {
  return readJSON<Bot[]>(botsFile, []).sort((a, b) => b.createdAt - a.createdAt)
}
export function saveBots(list: Bot[]): void {
  writeJSON(botsFile, list)
}
export function upsertBot(bot: Bot): void {
  const list = listBots()
  const i = list.findIndex((b) => b.id === bot.id)
  if (i >= 0) list[i] = bot
  else list.push(bot)
  saveBots(list)
}
export function deleteBot(id: string): void {
  saveBots(listBots().filter((b) => b.id !== id))
  // 只从列表里摘掉是不够的：聊天记录和长期记忆还躺在磁盘上。
  // 用户删掉一个角色，通常就是要它彻底消失（隐私预期），所以文件一并清掉。
  deleteFile(`bot-chats/${id}.json`)
  deleteFile(`bot-chats/${id}.memory.json`)
}

// ---------- 单聊 ----------

export function getBotMessages(botId: string): BotMsg[] {
  return readJSON<BotMsg[]>(`bot-chats/${botId}.json`, [])
}
export function saveBotMessages(botId: string, msgs: BotMsg[]): void {
  writeJSON(`bot-chats/${botId}.json`, msgs)
}

/** 机器人的长期记忆：以 bot 自己的记忆文件存储（关键事实列表） */
interface BotMemory {
  botId: string
  facts: string[]
  updatedAt: number
}

export function loadBotMemory(botId: string): BotMemory {
  return readJSON<BotMemory>(`bot-chats/${botId}.memory.json`, { botId, facts: [], updatedAt: 0 })
}
export function saveBotMemory(m: BotMemory): void {
  m.updatedAt = Date.now()
  writeJSON(`bot-chats/${m.botId}.memory.json`, m)
}

/** 群聊的长期记忆（群维度共享，群内所有 bot 都能读） */
interface GroupMemory {
  groupId: string
  facts: string[]
  updatedAt: number
  /** 已经压缩到第几条消息（群消息一次涨两条，用「模 15」判断永远命不中） */
  compressedUpTo?: number
}

export function loadGroupMemory(groupId: string): GroupMemory {
  return readJSON<GroupMemory>(`group-chats/${groupId}.memory.json`, { groupId, facts: [], updatedAt: 0 })
}
export function saveGroupMemory(m: GroupMemory): void {
  m.updatedAt = Date.now()
  writeJSON(`group-chats/${m.groupId}.memory.json`, m)
}

/** 用 LLM 从一段对话文本里提炼长期记忆事实，失败返回空数组（调用方静默吞掉） */
async function extractFacts(target: LLMTarget, text: string): Promise<string[]> {
  const { completeOnce } = await import('./llm')
  const { parseFacts } = await import('./memory')
  try {
    const out = await completeOnce(target, [
      { role: 'system', content: MEM_PROMPT },
      { role: 'user', content: text }
    ])
    const facts = parseFacts(out)
    // 解析成功就照用——哪怕是空数组（说明模型判断这段没有值得记的），
    // 这时别兜底硬塞一条「此前聊到：…」，否则记忆里全是噪音，还会一直占上下文
    if (facts) return facts
  } catch {
    /* 落到下面兜底 */
  }
  // 模型没按要求给 JSON 也绝不能白丢这段对话：留一条原文摘录，至少保住线索
  const brief = text.replace(/\s+/g, ' ').slice(0, 140).trim()
  return brief ? [`此前聊到：${brief}`] : []
}

const activeAborts = new Map<string, AbortController>()

const MEM_PROMPT = `你从对话里挑选「值得长期记住的具体事实」，输出 JSON 字符串数组（中文，最多 5 条）。

只收这几类：
- 关于用户本人的具体信息：称呼/姓名、联系方式、住址、家人、工作与身份
- 具体的计划与时间：哪天要做什么、截止时间、预约
- 明确的偏好与习惯：喜欢/不喜欢什么、忌讳、固定做法
- 双方约定与承诺：说好要做的事、答应的安排
- 用户明确要求记住的事

一律不收：
- AI 自己说过的话、给出过的解释或建议
- 通用知识、定义、行业常识（比如「故障导向安全是什么」）
- 空泛判断（比如「用户关注安全」「用户很专业」）
- 寒暄、客套、没有信息量的对话

每条写成一句能独立看懂的话（谁、什么事、什么时候）。没有合格的条就输出 []。
只输出 JSON 数组本身，不要任何解释或前后缀。`

export interface BotSendOptions {
  botId: string
  userText: string
  emit: (event: { type: string; [k: string]: unknown }) => void
}

export async function sendBotMessage(opts: BotSendOptions): Promise<void> {
  const { botId, emit } = opts
  // 并发防护：该机器人上一条还在生成时拒绝新消息（否则 AbortController 被覆盖，旧流失控）
  if (activeAborts.has(botId)) {
    emit({ type: 'error', botId, message: '上一条回复还在生成中，等它说完或点停止后再发' })
    return
  }
  const bot = listBots().find((b) => b.id === botId)
  if (!bot) {
    emit({ type: 'error', botId, message: '机器人不存在' })
    return
  }
  const msgs = getBotMessages(botId)
  msgs.push({ id: 'bm_' + Date.now().toString(36), sender: 'user', content: opts.userText, ts: Date.now() })
  saveBotMessages(botId, msgs)
  // 事件一律带 botId：渲染层按它过滤，切换机器人后进行中的流不会灌进别的会话
  emit({ type: 'user-saved', botId, content: opts.userText })

  const ac = new AbortController()
  activeAborts.set(botId, ac)

  const mem = loadBotMemory(botId)
  const globalPref = loadGlobalMemory()

  // 用户明确说「记住」时立刻提炼，不等「每 12 条」那一轮。
  // 界面承诺「TA 会一直记得你说的每件事」，可真说「你记住这个事」却要聊满 6 轮才生效，
  // 等于承诺没兑现。这里异步做，不挡回复速度。
  if (/记住|记一下|记着|别忘了|别忘|牢记|remember/i.test(opts.userText)) {
    const recent = msgs
      .slice(-6)
      .map((m) => `${m.sender === 'user' ? '用户' : bot.name}: ${m.content.slice(0, 400)}`)
      .join('\n')
    void extractFacts(bot.target, recent)
      .then(async (facts) => {
        if (!facts.length) return
        const { isDuplicateFact } = await import('./memory')
        // 重新读一次：提炼期间可能已被「每 12 条」那条路径写过
        const fresh = loadBotMemory(botId)
        let changed = false
        for (const f of facts) {
          if (!isDuplicateFact(f, fresh.facts)) {
            fresh.facts.push(f)
            changed = true
          }
        }
        if (!changed) return
        if (fresh.facts.length > 50) fresh.facts = fresh.facts.slice(-50)
        saveBotMemory(fresh)
        emit({ type: 'memory-updated', botId, count: fresh.facts.length })
      })
      .catch(() => {})
  }

  let system =
    `你叫「${bot.name}」，是一位长期陪伴用户的 AI 伙伴。请始终以以下人格说话：\n${bot.persona}\n\n` +
    `要求：口语化、有温度、记住你们的关系是长期的朋友。不要自称 AI 助手，不要输出 Markdown 标题格式，就像微信聊天一样自然。\n` +
    (globalPref.preferences.length
      ? `【用户偏好】\n${globalPref.preferences.map((p) => '- ' + p).join('\n')}\n`
      : '') +
    (mem.facts.length
      ? `\n【你长期记住的关于用户的事】\n${mem.facts.map((f) => '- ' + f).join('\n')}`
      : '')
  // 本地生成能力认知（画笔/作曲能力，何时该用 / 不该用）
  const caps = mediaCapabilitiesPrompt()
  if (caps) system += '\n\n' + caps + '\n（作为伙伴，你可以把它理解为你的「画笔 / 作曲能力」：用户想要时才动用，平时正常聊天。）'
  const mediaTools = mediaToolDefs()

  // 机器人上下文预算（设置-记忆里单独可调）：注入窗口超预算 80% 时收缩窗口，
  // 切掉的较早内容后台压缩成长期记忆事实（下一轮注入），聊天原文仍在磁盘可回看
  const budget = loadSettings().botsTokens ?? loadSettings().memoryTokens ?? 32768
  let window = msgs.slice(-40)
  const windowTokens = (arr: typeof window): number => arr.reduce((n, m) => n + estimateTokens(m.content), 0)
  const dropped: typeof window = []
  while (window.length > 10 && windowTokens(window) > budget * 0.8) {
    const cut = Math.max(1, Math.floor(window.length * 0.25))
    dropped.push(...window.slice(0, cut))
    window = window.slice(cut)
  }
  if (dropped.length) {
    const text = dropped.map((m) => `${m.sender === 'user' ? '用户' : bot.name}: ${m.content.slice(0, 500)}`).join('\n')
    extractFacts(bot.target, text)
      .then(async (facts) => {
        if (facts.length) {
          const { isDuplicateFact } = await import('./memory')
          for (const f of facts) if (!isDuplicateFact(f, mem.facts)) mem.facts.push(f)
          if (mem.facts.length > 50) mem.facts = mem.facts.slice(-50)
          saveBotMemory(mem)
        }
      })
      .catch(() => {})
  }

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: system },
    ...window.map((m) => ({ role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content } as ChatMessage))
  ]

  let reply = ''
  const media: { images?: string[]; video?: string; audio?: string } = {}
  try {
    // 最多 2 轮工具循环（生成类工具较慢，克制使用）
    for (let round = 0; round < 3; round++) {
      let roundText = ''
      let roundError: string | null = null
      let toolCalls: ToolCall[] | undefined
      await streamChat(
        bot.target,
        llmMessages,
        {
          onDelta: (t) => {
            reply += t
            roundText += t
            emit({ type: 'delta', botId, text: t })
          },
          onToolCalls: (calls) => {
            toolCalls = calls
          },
          onDone: () => {},
          onError: (m) => {
            roundError = m
            emit({ type: 'error', botId, message: m })
          }
        },
        { signal: ac.signal, numCtx: budget, ...(mediaTools.length ? { tools: mediaTools as any } : {}) }
      )
      if (roundError || !toolCalls || toolCalls.length === 0) break
      llmMessages.push({ role: 'assistant', content: roundText || '(用画笔/乐器中)' })
      for (const call of toolCalls) {
        const r = await execMediaTool(call, (t) => emit({ type: 'bot-typing', botId, botName: t }))
        if (r.fileName && r.kind === 'image') (media.images ??= []).push(r.fileName)
        else if (r.fileName && r.kind === 'video') media.video = r.fileName
        else if (r.fileName && r.kind === 'audio') media.audio = r.fileName
        llmMessages.push({ role: 'user', content: `工具 ${call.name} 返回: ${r.result}` })
      }
    }
    const cur = getBotMessages(botId)
    cur.push({
      id: 'bm_' + (Date.now() + 1).toString(36),
      sender: 'bot',
      botId,
      content: reply,
      images: media.images?.length ? media.images : undefined,
      video: media.video,
      audio: media.audio,
      ts: Date.now()
    })
    saveBotMessages(botId, cur)
    // content 随 done 下发：渲染层以它为准落消息，流式中途切换也不丢字/不重复
    emit({ type: 'done', botId, content: reply, images: media.images, video: media.video, audio: media.audio })
    // 每 12 条消息压缩一次长期记忆（后台）
    if (cur.length % 12 === 0) {
      const text = cur.slice(-12).map((m) => `${m.sender === 'user' ? '用户' : bot.name}: ${m.content.slice(0, 500)}`).join('\n')
      try {
        const facts = await extractFacts(bot.target, text)
        if (facts.length) {
          const { isDuplicateFact } = await import('./memory')
          // 重新读：即时记忆那条路径可能刚写过
          const fresh = loadBotMemory(botId)
          let changed = false
          for (const f of facts) {
            if (!isDuplicateFact(f, fresh.facts)) {
              fresh.facts.push(f)
              changed = true
            }
          }
          if (changed) {
            if (fresh.facts.length > 50) fresh.facts = fresh.facts.slice(-50)
            saveBotMemory(fresh)
            emit({ type: 'memory-updated', botId, count: fresh.facts.length })
          }
        }
      } catch { /* 静默 */ }
    }
  } catch (err) {
    if (!(err instanceof AbortedError)) {
      emit({ type: 'error', botId, message: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    activeAborts.delete(botId)
    emit({ type: 'end', botId })
  }
}

export function stopBot(botId: string): void {
  activeAborts.get(botId)?.abort()
}

/** 正在回复的伙伴/群（切页回来恢复状态用；单聊和群聊共用这张表） */
export function activeBotSessions(): string[] {
  return [...activeAborts.keys()]
}

// ---------- 群聊 ----------

export function listGroups(): Group[] {
  return readJSON<Group[]>(groupsFile, []).sort((a, b) => b.createdAt - a.createdAt)
}
function saveGroups(list: Group[]): void {
  writeJSON(groupsFile, list)
}
export function createGroup(name: string, botIds: string[]): Group {
  const g: Group = {
    id: 'g_' + Date.now().toString(36),
    name,
    botIds,
    rotationIndex: 0,
    createdAt: Date.now()
  }
  saveGroups([...listGroups(), g])
  return g
}
export function updateGroup(id: string, patch: Partial<Group>): Group {
  const list = listGroups()
  const i = list.findIndex((g) => g.id === id)
  if (i < 0) throw new Error('群不存在')
  list[i] = { ...list[i], ...patch }
  saveGroups(list)
  return list[i]
}
export function deleteGroup(id: string): void {
  saveGroups(listGroups().filter((g) => g.id !== id))
  // 同上：群聊记录和群长期记忆也要跟着删，否则「删群」只是藏起来
  deleteFile(`group-chats/${id}.json`)
  deleteFile(`group-chats/${id}.memory.json`)
}

export function getGroupMessages(groupId: string): BotMsg[] {
  return readJSON<BotMsg[]>(`group-chats/${groupId}.json`, [])
}
export function saveGroupMessages(groupId: string, msgs: BotMsg[]): void {
  writeJSON(`group-chats/${groupId}.json`, msgs)
}

export interface GroupSendOptions {
  groupId: string
  userText: string
  emit: (event: { type: string; [k: string]: unknown }) => void
}

/** 群聊发言：@了谁谁答；没 @ 则轮换一个机器人答 */
export async function sendGroupMessage(opts: GroupSendOptions): Promise<void> {
  const { groupId, emit } = opts
  // 并发防护：该群上一轮还在进行时拒绝新消息
  if (activeAborts.has(groupId)) {
    emit({ type: 'error', groupId, message: '上一轮回复还在进行中，请稍候或点停止' })
    return
  }
  const group = listGroups().find((g) => g.id === groupId)
  if (!group) {
    emit({ type: 'error', groupId, message: '群不存在' })
    return
  }
  const bots = listBots().filter((b) => group.botIds.includes(b.id))
  if (!bots.length) {
    emit({ type: 'error', groupId, message: '群里没有机器人' })
    return
  }

  const msgs = getGroupMessages(groupId)
  msgs.push({ id: 'gm_' + Date.now().toString(36), sender: 'user', content: opts.userText, ts: Date.now() })
  saveGroupMessages(groupId, msgs)
  // 事件带 groupId：多群并行时渲染层按它过滤
  emit({ type: 'user-saved', groupId, content: opts.userText })

  // 决定谁回复
  const mentioned = bots.filter((b) => opts.userText.includes('@' + b.name))
  let responders: Bot[]
  if (mentioned.length) responders = mentioned
  else {
    responders = [bots[group.rotationIndex % bots.length]]
    updateGroup(groupId, { rotationIndex: (group.rotationIndex + 1) % Math.max(bots.length, 1) })
  }

  for (const bot of responders) {
    if (activeAborts.get(groupId)?.signal.aborted) break
    await botSpeakInGroup(group, bot, bots, opts.userText, emit)
  }
  emit({ type: 'end', groupId })
}

async function botSpeakInGroup(
  group: Group,
  bot: Bot,
  allBots: Bot[],
  userText: string,
  emit: (e: { type: string; [k: string]: unknown }) => void
): Promise<void> {
  const msgs = getGroupMessages(group.id)
  const mem = loadBotMemory(bot.id)
  const gmem = loadGroupMemory(group.id)
  const others = allBots.filter((b) => b.id !== bot.id).map((b) => b.name).join('、')
  let system =
    `你是群聊「${group.name}」里的成员「${bot.name}」。人格设定：\n${bot.persona}\n\n` +
    (others ? `群里的其他成员: ${others}。其他成员发言时你可以适当回应，但不要替别人说话。\n` : '') +
    (mem.facts.length ? `【你记住的关于用户的事】\n${mem.facts.map((f) => '- ' + f).join('\n')}\n` : '') +
    (gmem.facts.length ? `【这个群里大家聊过、值得记住的事】\n${gmem.facts.map((f) => '- ' + f).join('\n')}\n` : '') +
    `像微信群聊一样自然发言，简短口语化，一次回复不要超过 3 句。不要自称 AI。`

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: system },
    ...msgs.slice(-30).map((m) => {
      const name = m.sender === 'user' ? '用户' : allBots.find((b) => b.id === m.botId)?.name ?? '成员'
      return { role: 'user' as const, content: `${name}: ${m.content}` } as ChatMessage
    })
  ]

  const ac = new AbortController()
  activeAborts.set(group.id, ac)
  let reply = ''
  emit({ type: 'bot-typing', groupId: group.id, botId: bot.id, botName: bot.name })
  try {
    await streamChat(
      bot.target,
      llmMessages,
      {
        onDelta: (t) => {
          reply += t
          emit({ type: 'delta', groupId: group.id, botId: bot.id, text: t })
        },
        onDone: () => emit({ type: 'done', groupId: group.id, botId: bot.id, content: reply }),
        onError: (m) => emit({ type: 'error', groupId: group.id, message: m })
      },
      { signal: ac.signal }
    )
    const cur = getGroupMessages(group.id)
    cur.push({ id: 'gm_' + (Date.now() + 1).toString(36), sender: 'bot', botId: bot.id, content: reply, ts: Date.now() })
    saveGroupMessages(group.id, cur)
    // 群长期记忆：距上次压缩累计满 15 条就提炼一次（原来用 cur.length % 15 判断，
    // 但群消息是「用户 1 条 + 机器人 1 条」成对增长，长度永远是偶数，模 15 永远命不中 → 从不触发）
    const gmem = loadGroupMemory(group.id)
    const from = gmem.compressedUpTo ?? 0
    if (cur.length - from >= 15) {
      const text = cur
        .slice(from)
        .map((m) => `${m.sender === 'user' ? '用户' : allBots.find((b) => b.id === m.botId)?.name ?? '成员'}: ${m.content.slice(0, 500)}`)
        .join('\n')
      try {
        const facts = await extractFacts(bot.target, text)
        if (facts.length) {
          const { isDuplicateFact } = await import('./memory')
          for (const f of facts) if (!isDuplicateFact(f, gmem.facts)) gmem.facts.push(f)
          if (gmem.facts.length > 50) gmem.facts = gmem.facts.slice(-50)
        }
        gmem.compressedUpTo = cur.length
        gmem.updatedAt = Date.now()
        saveGroupMemory(gmem)
      } catch {
        /* 失败就不推进，下次再试 */
      }
    }
  } catch (err) {
    if (!(err instanceof AbortedError)) {
      emit({ type: 'error', groupId: group.id, message: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    activeAborts.delete(group.id)
  }
}

export function stopGroup(groupId: string): void {
  activeAborts.get(groupId)?.abort()
}
