/**
 * 模型调用层 —— 统一适配 OpenAI 兼容端点与 Anthropic。
 * 全部流式；推理模型的思考内容以 reasoning 事件单独回调。
 * 网络白名单：只请求 settings 里配置的 baseUrl。
 */
import { loadSettings, getProviderKey, ProviderConfig } from './store'
import { imageToDataUrl, safeImagePath } from './images'
import * as fs from 'fs'
import * as path from 'path'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 图片文件名（存于数据目录 images/），发送时转 base64 data URL；仅 OpenAI 兼容与 Anthropic 多模态格式 */
  images?: string[]
}

export interface StreamCallbacks {
  onDelta: (text: string) => void
  onReasoning?: (text: string) => void
  onDone: (full: string) => void
  onError: (msg: string) => void
}

export interface LLMTarget {
  providerId: string
  model: string
}

function providerOf(providerId: string): ProviderConfig {
  const s = loadSettings()
  const p = s.providers.find((x) => x.id === providerId)
  if (!p) throw new Error(`未找到供应商 ${providerId}`)
  return p
}

interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface AgentStreamCallbacks extends StreamCallbacks {
  onToolCalls?: (calls: ToolCall[]) => void
}

/** 判断错误是否为中止标记 */
export class AbortedError extends Error {}

export async function streamChat(
  target: LLMTarget,
  messages: ChatMessage[],
  cb: AgentStreamCallbacks,
  opts?: {
    signal?: AbortSignal
    temperature?: number
    tools?: ToolDef[]
    maxTokens?: number
    reasoningLevel?: 'off' | 'low' | 'high'
    /** 会话上下文预算：Ollama 侧映射为 num_ctx，否则本地模型固定 4096 上下文，预算形同虚设 */
    numCtx?: number
  }
): Promise<void> {
  const p = providerOf(target.providerId)
  const key = getProviderKey(target.providerId)
  const isLocal = p.id === 'ollama'
  if (!isLocal && !key && p.apiType === 'anthropic') {
    cb.onError('未配置该供应商的 API Key，请在设置中填写')
    return
  }
  try {
    if (p.apiType === 'anthropic') {
      await streamAnthropic(p, key, target.model, messages, cb, opts)
    } else {
      await streamOpenAI(p, key, target.model, messages, cb, opts)
    }
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError' || err instanceof AbortedError) {
      cb.onError('__aborted__')
      return
    }
    cb.onError(humanizeLLMError(err, p, target.model))
  }
}

/**
 * 把底层错误翻成人话，并告诉用户下一步该做什么。
 * 原来是把 err.message 原样抛给界面——本地服务没起来时用户只看到一句 "fetch failed"，
 * 既不知道哪里出了问题，也不知道该怎么办。
 */
function humanizeLLMError(err: unknown, p: ProviderConfig, model: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  const anyErr = err as { cause?: { code?: string }; code?: string; name?: string }
  const code = anyErr?.cause?.code ?? anyErr?.code ?? ''
  const isLocal = p.id === 'ollama'

  if (anyErr?.name === 'TimeoutError' || /timeout|timed out/i.test(raw)) {
    return isLocal
      ? '本地模型响应超时。刚切换到较大的模型时第一次加载会比较慢，可以重试一次；一直超时的话建议在设置里换个小一点的模型。'
      : `${p.name} 响应超时，请稍后重试。`
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|ENETUNREACH/i.test(raw + ' ' + code)) {
    if (isLocal) {
      return '连不上本地 Ollama（127.0.0.1:11434）。请到「设置 → 本地模型」确认服务在运行，或者重启小镜让它自动拉起。'
    }
    return `连不上 ${p.name} 的服务器${code ? `（${code}）` : ''}。请检查网络连接或代理设置。`
  }
  const statusMatch = raw.match(/\((\d{3})\)/)
  if (statusMatch) {
    const n = Number(statusMatch[1])
    if (n === 401 || n === 403) return `${p.name} 拒绝了请求：API Key 无效或没有权限。请到「设置 → 模型供应商」重新填写密钥。`
    if (n === 404) return `${p.name} 上找不到模型「${model}」。请到设置里重新拉取模型列表，或换一个模型。`
    if (n === 429) return `${p.name} 提示请求太频繁或额度用完了，请稍后再试。`
    if (n === 400) {
      const detail = raw.replace(/^.*?\(\d{3}\)[:：]?\s*/, '').slice(0, 200)
      return `请求被 ${p.name} 拒绝（参数问题）：${detail || '可能是模型不支持当前功能（比如不支持工具调用或图片）'}`
    }
    if (n >= 500) return `${p.name} 服务端出错（${n}），通常稍后重试即可。`
  }
  return raw
}

async function readSSE(
  res: Response,
  extract: (json: any) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    if (signal?.aborted) {
      reader.cancel().catch(() => {})
      throw new AbortedError('aborted')
    }
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        extract(JSON.parse(payload))
      } catch { /* 忽略不完整分片 */ }
    }
  }
}

async function streamOpenAI(
  p: ProviderConfig,
  key: string,
  model: string,
  messages: ChatMessage[],
  cb: AgentStreamCallbacks,
  opts?: {
    signal?: AbortSignal
    temperature?: number
    tools?: ToolDef[]
    maxTokens?: number
    reasoningLevel?: 'off' | 'low' | 'high'
    numCtx?: number
  }
): Promise<void> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true }
  }
  // Ollama 上下文：实测 /v1/chat/completions 兼容端点不透传 num_ctx（请求体里带了也被忽略），
  // 真正生效的是启动 serve 时的 OLLAMA_CONTEXT_LENGTH 环境变量（本机已设 32768）。
  // 这里仍带上 options：未来 Ollama 支持透传时自动生效；对支持 options 的第三方兼容端点也可能有用
  if (opts?.numCtx && p.id === 'ollama') body.options = { num_ctx: Math.min(opts.numCtx, 32768) }
  if (opts?.temperature !== undefined) body.temperature = opts.temperature
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens
  if (opts?.tools?.length) body.tools = opts.tools
  // 推理等级：按各家 API 的真实参数映射
  // - GLM: thinking.type enabled/disabled（GLM 默认开思考，"无"必须显式关闭）
  // - Ollama: reasoning_effort none/low/high（实测 none 可关闭 qwen3 思考）
  // - 其他 OpenAI 兼容端点: 不发参数（默认行为）或 reasoning_effort
  if (p.id === 'glm') {
    body.thinking = { type: opts?.reasoningLevel && opts.reasoningLevel !== 'off' ? 'enabled' : 'disabled' }
  } else if (p.id === 'ollama') {
    body.reasoning_effort = opts?.reasoningLevel === 'high' ? 'high' : opts?.reasoningLevel === 'low' ? 'low' : 'none'
  } else if (opts?.reasoningLevel && opts.reasoningLevel !== 'off') {
    body.reasoning_effort = opts.reasoningLevel
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  if (p.id === 'openrouter') headers['HTTP-Referer'] = 'http://localhost/xiaojing'

  // 多模态：带图片的消息转成 content parts（text + image_url data URL）
  const mapped = messages.map((m) => {
    if (!m.images?.length || m.role === 'system') return m
    const urls = m.images.map(imageToDataUrl).filter((u): u is string => !!u)
    if (!urls.length) return m
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content },
        ...urls.map((u) => ({ type: 'image_url', image_url: { url: u } }))
      ]
    }
  })
  const bodySend: Record<string, unknown> = { ...body, messages: mapped }

  const res = await fetch(p.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(bodySend),
    signal: opts?.signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${p.name} 请求失败 (${res.status}): ${text.slice(0, 500)}`)
  }
  const toolAcc = new Map<number, ToolCall>()
  await readSSE(
    res,
    (json) => {
      const delta = json.choices?.[0]?.delta
      if (!delta) return
      if (delta.reasoning_content) cb.onReasoning?.(delta.reasoning_content)
      else if (delta.reasoning) cb.onReasoning?.(delta.reasoning)
      if (delta.content) cb.onDelta(delta.content)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          if (!toolAcc.has(idx)) {
            toolAcc.set(idx, { id: tc.id ?? `call_${idx}`, name: '', arguments: '' })
          }
          const acc = toolAcc.get(idx)!
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name += tc.function.name
          if (tc.function?.arguments) acc.arguments += tc.function.arguments
        }
      }
    },
    opts?.signal
  )
  if (toolAcc.size > 0 && cb.onToolCalls) {
    cb.onToolCalls([...toolAcc.values()].filter((t) => t.name))
  }
  cb.onDone('')
}

async function streamAnthropic(
  p: ProviderConfig,
  key: string,
  model: string,
  messages: ChatMessage[],
  cb: AgentStreamCallbacks,
  opts?: { signal?: AbortSignal; temperature?: number; tools?: ToolDef[]; maxTokens?: number }
): Promise<void> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      // 多模态：图片转 Anthropic 的 base64 source 块
      if (m.images?.length) {
        const blocks: unknown[] = [{ type: 'text', text: m.content }]
        for (const name of m.images) {
          const full = safeImagePath(name)
          if (!full || !fs.existsSync(full)) continue
          const buf = fs.readFileSync(full)
          const ext = path.extname(name).slice(1).toLowerCase()
          const mime = ext === 'jpg' ? 'jpeg' : ext || 'png'
          blocks.push({ type: 'image', source: { type: 'base64', media_type: `image/${mime}`, data: buf.toString('base64') } })
        }
        if (blocks.length > 1) return { role: m.role as 'user' | 'assistant', content: blocks }
      }
      return { role: m.role as 'user' | 'assistant', content: m.content }
    })
  const body: Record<string, unknown> = {
    model,
    system: system || undefined,
    messages: rest,
    stream: true,
    max_tokens: opts?.maxTokens ?? 8192
  }
  if (opts?.temperature !== undefined) body.temperature = opts.temperature

  const anthBase = p.baseUrl.replace(/\/+$/, '')
  const res = await fetch(/\/v1$/.test(anthBase) ? anthBase + '/messages' : anthBase + '/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: opts?.signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${p.name} 请求失败 (${res.status}): ${text.slice(0, 500)}`)
  }
  let full = ''
  await readSSE(
    res,
    (json) => {
      if (json.type === 'content_block_delta') {
        if (json.delta?.type === 'thinking_delta') cb.onReasoning?.(json.delta.thinking ?? '')
        else if (json.delta?.type === 'text_delta') {
          full += json.delta.text
          cb.onDelta(json.delta.text)
        }
      }
    },
    opts?.signal
  )
  cb.onDone(full)
}

/** 非流式调用（记忆压缩等后台任务用） */
/**
 * 一次性（非流式）调用：等待完整回复。
 *
 * 超时与取消是硬需求——以前这里裸调 streamChat，没有 signal 也没有超时：
 * 辅助模型冷加载（如 18GB 的 30B 模型）或上游卡住时，整个对话会无限等待，
 * 用户点「停止」也停不下来（实测卡满 120s 无响应）。
 */
export async function completeOnce(
  target: LLMTarget,
  messages: ChatMessage[],
  opts?: {
    temperature?: number
    maxTokens?: number
    numCtx?: number
    signal?: AbortSignal
    timeoutMs?: number
  }
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 180000
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, timeoutMs)
  const onOuterAbort = (): void => ac.abort()
  if (opts?.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  return new Promise<string>((resolve, reject) => {
    let out = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onOuterAbort)
      fn()
    }
    ac.signal.addEventListener('abort', () => {
      finish(() =>
        reject(new Error(timedOut ? `请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）` : '已取消'))
      )
    })
    streamChat(
      target,
      messages,
      {
        onDelta: (t) => (out += t),
        onDone: () => finish(() => resolve(out)),
        onError: (m) => finish(() => reject(new Error(m)))
      },
      {
        temperature: opts?.temperature ?? 0.3,
        ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
        ...(opts?.numCtx ? { numCtx: opts.numCtx } : {}),
        signal: ac.signal
      }
    ).catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
  })
}

/** 拉取 OpenAI 兼容端点的模型列表 */
export async function listModels(providerId: string): Promise<string[]> {
  const p = providerOf(providerId)
  const key = getProviderKey(providerId)
  if (p.id === 'anthropic') {
    const res = await fetch(/\/v1$/.test(p.baseUrl.replace(/\/+$/, '')) ? p.baseUrl.replace(/\/+$/, '') + '/models' : p.baseUrl.replace(/\/+$/, '') + '/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    })
    if (!res.ok) throw new Error(`获取模型列表失败 (${res.status})`)
    const json = await res.json()
    return (json.data ?? []).map((m: any) => m.id)
  }
  const headers: Record<string, string> = {}
  if (key) headers.Authorization = `Bearer ${key}`
  const res = await fetch(p.baseUrl.replace(/\/$/, '') + '/models', { headers })
  if (!res.ok) throw new Error(`获取模型列表失败 (${res.status})`)
  const json = await res.json()
  return (json.data ?? json.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean)
}
