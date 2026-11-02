/**
 * 记忆引擎 —— 「越用越顺手」的核心：
 * - 会话记忆：旧消息自动压缩为关键事实，注入后续对话
 * - 全局偏好：后台提炼用户习惯，注入所有对话
 */
import { readJSON, writeJSON, loadSettings } from './store'
import { completeOnce, ChatMessage, LLMTarget } from './llm'

export interface SessionMemory {
  sessionId: string
  facts: string[] // 压缩出的关键事实
  compressedUpTo: number // 已压缩到第几条消息（含）
  updatedAt: number
}

export interface GlobalMemory {
  preferences: string[] // 用户偏好（简洁、语言习惯、代码风格等）
  updatedAt: number
}

const memFile = (sessionId: string) => `chat-memory/${sessionId}.json`
const globalFile = 'global-memory.json'

export function loadSessionMemory(sessionId: string): SessionMemory {
  return readJSON<SessionMemory>(memFile(sessionId), {
    sessionId,
    facts: [],
    compressedUpTo: 0,
    updatedAt: 0
  })
}

export function saveSessionMemory(m: SessionMemory): void {
  m.updatedAt = Date.now()
  writeJSON(memFile(m.sessionId), m)
}

export function clearSessionMemory(sessionId: string): void {
  writeJSON(memFile(sessionId), {
    sessionId,
    facts: [],
    compressedUpTo: 0,
    updatedAt: Date.now()
  })
}

export function loadGlobalMemory(): GlobalMemory {
  return readJSON<GlobalMemory>(globalFile, { preferences: [], updatedAt: 0 })
}

export function saveGlobalMemory(g: GlobalMemory): void {
  g.updatedAt = Date.now()
  writeJSON(globalFile, g)
}

/** 生成注入 system 的记忆前缀 */
export function memoryPrefix(sessionId: string): string {
  const g = loadGlobalMemory()
  const s = loadSessionMemory(sessionId)
  const parts: string[] = []
  if (g.preferences.length) {
    parts.push(`【用户偏好】（从历史使用中学习，请遵循）\n${g.preferences.map((p) => '- ' + p).join('\n')}`)
  }
  if (s.facts.length) {
    parts.push(`【本会话记忆】（早期对话的压缩摘要）\n${s.facts.map((f) => '- ' + f).join('\n')}`)
  }
  return parts.join('\n\n')
}

const COMPRESS_PROMPT = `你是记忆压缩器。把以下对话中值得长期记住的信息提炼成关键事实，输出 JSON 字符串数组（形如 ["事实一","事实二"]），不要输出任何其他内容。
必须尽量保住这些具体信息：人名与角色、时间节点、数字与金额、地点、已定的决定、未完成的任务、用户的偏好。
不要写"用户提到了某个项目"这种空话，要写清是什么项目、什么时间、谁负责。最多 10 条，每条一句话，用中文。`

/** 事实去重：多轮压缩常把同一段信息拆成好几条（"项目经理姓陈" / "项目经理为陈姓"），
 *  重复的条目既浪费上下文又让记忆面板显得啰嗦。彼此包含或高度相似的就算重复。 */
function normalizeFact(s: string): string {
  return s.replace(/[\s，。、：；！？,.:;!?"'“”‘’（）()]/g, '')
}

export function isDuplicateFact(fact: string, list: string[]): boolean {
  const a = normalizeFact(fact)
  if (!a) return true
  for (const item of list) {
    const b = normalizeFact(item)
    if (!b) continue
    if (a === b) return true
    const short = a.length <= b.length ? a : b
    const long = a.length <= b.length ? b : a
    // 短的被长的完整包含（长度差不能太悬殊，否则"总投资四点二亿"会吃掉一大段）
    if (short.length >= 6 && long.includes(short) && short.length / long.length >= 0.5) return true
  }
  return false
}

/** 从模型输出里尽量抠出事实数组：先按 JSON 解析，失败再按列表行兜底 */
export function parseFacts(out: string): string[] | null {
  const cleaned = out.replace(/```(?:json)?/gi, '').trim()
  // 模型经常不老实：数组里装的不是字符串，而是 {"用户偏好": "...", "具体": "..."} 这种对象
  const asText = (x: unknown): string => {
    if (typeof x === 'string') return x.trim()
    if (x && typeof x === 'object') {
      const vals = Object.values(x as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && !!v.trim())
      // 取最长的那条：通常是最具体的描述
      return vals.sort((a, b) => b.length - a.length)[0]?.trim() ?? ''
    }
    return ''
  }
  const m = cleaned.match(/\[[\s\S]*\]/)
  if (m) {
    try {
      const arr = JSON.parse(m[0])
      if (Array.isArray(arr)) {
        return arr.map(asText).filter(Boolean)
      }
    } catch {
      /* 落到列表行兜底 */
    }
  }
  const lines = cleaned
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*·•]|\d+[.)、])\s*/, '').trim())
    .filter(
      (l) =>
        l.length > 4 &&
        !/^[[{]/.test(l) &&
        // 模型说「没有值得记住的」时不能把这句话本身当记忆存进去
        !/^(?:没有|没有值得|无|无需|抱歉|无法|这段|该对话|以上|综上|未发现|暂无可)/.test(l)
    )
  if (lines.length) return lines.slice(0, 10)
  return null
}

/** 模型说不出事实时的兜底：至少把这段对话里最关键的原话摘出来，绝不空手丢信息 */
function fallbackFacts(chunk: ChatMessage[]): string[] {
  const users = chunk.filter((m) => m.role === 'user')
  const first = (users[0] ?? chunk[0])?.content ?? ''
  const brief = first.replace(/\s+/g, ' ').slice(0, 160).trim()
  return brief ? [`用户此前说过：${brief}`] : []
}

/** 估算 token：中文约 1 字 1 token，英文约 4 字符 1 token（偏保守，宁可早压缩） */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x2e80) cjk++
  }
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/**
 * 会话上下文用量达到预算 80% 时，把最旧的一段消息压缩为事实（单会话内生效）。
 * force = 用户主动要求压缩（如发送「上下文压缩」），至少压一段。
 */
export async function maybeCompressSession(
  sessionId: string,
  messages: ChatMessage[],
  target: LLMTarget,
  opts?: { budget?: number; force?: boolean }
): Promise<void> {
  const budget = opts?.budget ?? loadSettings().memoryTokens ?? 32768
  const mem = loadSessionMemory(sessionId)
  let total = 0
  for (let i = mem.compressedUpTo; i < messages.length; i++) {
    total += estimateTokens(messages[i].content)
  }
  if (!opts?.force && total < budget * 0.8) return
  // 分段压缩最旧的消息（每次调用最多压 3 段，一段 25%），压到预算的 60% 以下
  const pending = messages.length - mem.compressedUpTo
  const step = Math.max(1, Math.floor(pending * 0.25))
  for (let round = 0; round < 3; round++) {
    if (round > 0 && total <= budget * 0.6) break
    const chunk = messages.slice(mem.compressedUpTo, mem.compressedUpTo + step)
    if (chunk.length === 0) break
    const text = chunk.map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content.slice(0, 2000)}`).join('\n')
    let facts: string[] | null = null
    try {
      const out = await completeOnce(target, [
        { role: 'system', content: COMPRESS_PROMPT },
        { role: 'user', content: text }
      ])
      facts = parseFacts(out)
      if (!facts || !facts.length) {
        // 以前这里解析失败也算"压过了"，消息被丢但一条事实都没留下 —— 用户说的关键背景会凭空消失
        const fb = fallbackFacts(chunk)
        console.log(`[memory] 压缩未拿到有效事实（解析${facts ? '为空' : '失败'}），改用兜底摘要 ${fb.length} 条`)
        facts = fb
      }
    } catch {
      // 压缩请求本身失败：这段先不推进，下次再试（推进等于白丢消息）
      console.log('[memory] 压缩请求失败，保留原文待下次重试')
      break
    }
    if (facts.length) {
      for (const f of facts.slice(0, 10)) {
        if (!isDuplicateFact(f, mem.facts)) mem.facts.push(f)
      }
    }
    if (mem.facts.length > 40) mem.facts = mem.facts.slice(-40)
    for (const m of chunk) total -= estimateTokens(m.content)
    mem.compressedUpTo += chunk.length
    saveSessionMemory(mem)
  }
}

const PREF_PROMPT = `你是偏好分析器。根据以下用户对话片段，提炼出能帮助 AI 更好服务该用户的稳定偏好（如：回答风格偏好、语言习惯、常见任务类型、代码风格要求）。只输出 JSON 字符串数组，没有新偏好就输出 []。不要输出其他内容，用中文，每条一句话。`

/** 后台学习全局用户偏好（每次聊天结束后调用，内部按频率节流） */
let userMsgCount = 0
export async function learnPreferences(
  recentMessages: ChatMessage[],
  target: LLMTarget
): Promise<void> {
  userMsgCount++
  if (userMsgCount % 10 !== 0) return // 每 10 条用户消息学习一次
  const text = recentMessages.slice(-16).map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content.slice(0, 800)}`).join('\n')
  try {
    const out = await completeOnce(target, [
      { role: 'system', content: PREF_PROMPT },
      { role: 'user', content: text }
    ])
    const prefs = parseFacts(out)
    if (!prefs) return
    const g = loadGlobalMemory()
    for (const p of prefs) {
      if (typeof p === 'string' && p.length > 2 && !g.preferences.includes(p)) {
        g.preferences.push(p)
      }
    }
    if (g.preferences.length > 30) g.preferences = g.preferences.slice(-30)
    saveGlobalMemory(g)
  } catch {
    // 静默失败
  }
}
