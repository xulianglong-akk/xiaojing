/**
 * 联合引擎 —— 「主模型 + 辅助模型」的调度中枢：
 * - 角色：辅助代理（子任务代做）/ 识图 / 上下文压缩 / 生图 / 生视频（预留）
 * - 主模型负责规划、说明、验收；简单任务可委派，但必须先判断辅助模型能否胜任
 * - 能力硬校验：角色未配置或供应商不可用时，对应工具根本不会暴露给主模型，
 *   双保险确保「不够格的任务坚决不交过去」
 */
import * as os from 'os'
import { loadSettings, ProviderConfig } from './store'
import { completeOnce, LLMTarget, ToolCall } from './llm'
import { generateImage } from './images'
import { ollamaStatus, ollamaLoaded } from './ollama'

export type FedRoleKey = 'subAgent' | 'vision' | 'compress' | 'imageGen' | 'videoGen'

export const FED_ROLES: { key: FedRoleKey; icon: string; label: string; desc: string; placeholder: string }[] = [
  {
    key: 'subAgent',
    icon: '🧠',
    label: '辅助代理',
    desc: '接收主模型委派的简单子任务（改写、翻译、总结、资料整理等），主模型负责规划与验收',
    placeholder: '由主模型兼任（不委派）'
  },
  {
    key: 'vision',
    icon: '👁',
    label: '识图',
    desc: '用户发送图片时，先由识图模型把图片转成详细文字描述，再交给主模型（主模型自己能看图则无需配置）',
    placeholder: '主模型自己看图'
  },
  {
    key: 'compress',
    icon: '📦',
    label: '上下文压缩',
    desc: '会话记忆压缩交给更快更便宜的模型完成，省时省钱',
    placeholder: '由主模型兼任'
  },
  {
    key: 'imageGen',
    icon: '🎨',
    label: '生图',
    desc: '文生图能力（走该厂商 /images/generations 接口）。主模型一般不具备生图能力，需要生图时必须配置此项',
    placeholder: '未配置（不启用生图）'
  },
  {
    key: 'videoGen',
    icon: '🎬',
    label: '生视频',
    desc: '预留角色：可先选定模型占位，调用能力后续版本接入',
    placeholder: '未配置（预留）'
  }
]

function providerUsable(p?: ProviderConfig): boolean {
  if (!p) return false
  return p.id === 'ollama' ? true : p.hasKey
}

/**
 * 解析角色：返回该角色实际使用的模型；null 表示回落主模型（或能力未启用）。
 * 校验：供应商必须存在且已配置可用（云厂商有 Key / Ollama），模型名非空。
 */
export function resolveRole(key: FedRoleKey, main: LLMTarget): LLMTarget | null {
  const fed = loadSettings().federation
  if (!fed?.enabled) return null
  const role = fed[key]
  if (!role || !role.providerId || !role.model) return null
  const p = loadSettings().providers.find((x) => x.id === role.providerId)
  if (!providerUsable(p)) return null
  // 与主模型相同 = 兼任，不需要委派
  if (role.providerId === main.providerId && role.model === main.model) return null
  return { providerId: role.providerId, model: role.model }
}

export function targetLabel(t: LLMTarget): string {
  const p = loadSettings().providers.find((x) => x.id === t.providerId)
  return `${p?.name ?? t.providerId} / ${t.model}`
}

/**
 * 辅助代理是不是「比主模型还重」。
 *
 * 本地模型的冷加载代价极高：18.6GB 的 30B 模型在 24GB 机器上要读盘一到两分钟，
 * 期间整轮对话卡死（实测 qwen3:30b-a3b 卡满 120 秒、系统内存吃满到 96%）。
 * 而「辅助代理」本该是更轻快的角色，为一句「人力怎么排」拉起 22GB 模型完全不成比例。
 *
 * 判定：目标模型没在内存里（要冷加载）+ 模型体积超过剩余可用内存的 75% → 不值得委派。
 * 云端模型不占本机内存，直接放行；检查本身失败也放行，避免误伤。
 */
async function subAgentTooHeavy(sub: LLMTarget): Promise<string | null> {
  if (sub.providerId !== 'ollama') return null
  try {
    const [st, loaded] = await Promise.all([ollamaStatus(), ollamaLoaded()])
    if (!st.running) return null
    if (loaded.some((m) => m.name === sub.model)) return null // 已驻留，不产生额外开销
    const model = st.models.find((m) => m.name === sub.model)
    if (!model || !model.size) return null // 名字对不上就别拦，交给 Ollama 自己报错
    const free = os.freemem()
    if (model.size > free * 0.75) {
      const sizeGb = (model.size / 1024 ** 3).toFixed(1)
      const freeGb = (free / 1024 ** 3).toFixed(1)
      return `辅助模型「${sub.model}」需要约 ${sizeGb}GB 内存，当前仅剩 ${freeGb}GB 可用；冷加载会拖住整个对话，不建议委派`
    }
  } catch {
    /* 检查失败不拦 */
  }
  return null
}

/** 注入给主模型的联合说明；没有可用辅助能力时返回 null（完全不打扰） */
export function federationPrompt(main: LLMTarget): string | null {
  const fed = loadSettings().federation
  if (!fed?.enabled) return null
  const sub = resolveRole('subAgent', main)
  const img = resolveRole('imageGen', main)
  if (!sub && !img) return null
  const lines: string[] = []
  lines.push('【联合模式】你是主模型，负责整体规划、说明与最终验收。')
  if (sub) {
    lines.push(
      `- 辅助代理「${targetLabel(sub)}」：只适合「量大且机械」的文字搬运（整篇翻译、润色、按固定格式批量改写、把长文压成摘要）。调用 delegate_task 工具委派。`
    )
  }
  if (img) {
    lines.push(`- 生图模型「${targetLabel(img)}」：需要生成图片时必须调用 generate_image 工具（你自己无法直接输出图片）。`)
  }
  lines.push('规则：')
  lines.push('1) 委派只用于「量大且机械」的文字转换。以下一律由你亲自完成，即使辅助模型很强也不委派：分析、推理、方案建议、排期与人力安排、判断与决策、对话闲聊，以及任何一两句话就能答完的问题。')
  lines.push('2) 委派指令必须自包含（辅助模型看不到你们的对话历史，必要背景要写进指令）。')
  lines.push('3) 辅助模型返回的结果必须经你验收整合后才交给用户，你对最终质量负责；不合格可修改后重试或自行完成。')
  lines.push('4) 日常问题默认自己答，别为了「用上联合模式」而硬凑委派——委派本身有启动代价，可能比你自己答还慢。')
  return lines.join('\n')
}

/** 联合工具定义（注入 LLM 的 tools 参数）；不可用的角色不出现 = 主模型无从调用 */
export function federationToolDefs(main: LLMTarget): unknown[] {
  const fed = loadSettings().federation
  if (!fed?.enabled) return []
  const defs: unknown[] = []
  const sub = resolveRole('subAgent', main)
  if (sub) {
    defs.push({
      type: 'function',
      function: {
        name: 'delegate_task',
        description: `把一个自包含的简单子任务委派给辅助模型「${targetLabel(sub)}」执行并返回其结果。仅当你判断该模型能够胜任时使用；指令要完整、含必要背景。`,
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: '给辅助模型的完整指令（自包含，它看不到对话历史）' }
          },
          required: ['task']
        }
      }
    })
  }
  const img = resolveRole('imageGen', main)
  if (img) {
    defs.push({
      type: 'function',
      function: {
        name: 'generate_image',
        description: `用生图模型「${targetLabel(img)}」生成一张图片并保存到本地。prompt 写清楚画面内容与风格（细节越具体效果越好）。`,
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '图片描述（画面、风格、构图等）' }
          },
          required: ['prompt']
        }
      }
    })
  }
  return defs
}

export interface FedToolResult {
  result: string // 回给主模型的工具结果文本
  images?: string[] // 生成的图片文件名（渲染层要展示）
}

/** 执行联合工具调用（delegate_task / generate_image）；log 用于向用户显示进度 */
export async function execFederationTool(
  call: ToolCall,
  main: LLMTarget,
  log: (text: string) => void,
  signal?: AbortSignal
): Promise<FedToolResult> {
  let args: any = {}
  try {
    args = JSON.parse(call.arguments || '{}')
  } catch {
    return { result: '参数解析失败，请重试' }
  }
  if (call.name === 'delegate_task') {
    const sub = resolveRole('subAgent', main)
    // 双保险：工具只在配置可用时注入；这里再拦一次运行中改配置的情况
    if (!sub) return { result: '辅助代理当前不可用（未配置或供应商未接入），请自行完成该任务。' }
    const task = String(args.task ?? '').trim()
    if (!task) return { result: '委派失败：task 为空' }
    // 拉起一个大模型去干小活，用户只会看到转圈——先掂量它扛不扛得住
    const heavy = await subAgentTooHeavy(sub)
    if (heavy) {
      log(`⚠ 未委派：${heavy}`)
      return { result: `${heavy}。请由你亲自完成这个任务，不要再调用 delegate_task。` }
    }
    log(`📨 子任务已委派给 ${targetLabel(sub)}…`)
    try {
      const out = await completeOnce(
        sub,
        [
          {
            role: 'system',
            content:
              '你是联合辅助代理，按主模型给出的指令直接、完整地输出结果（不要寒暄、不要询问、不要解释你在做什么）。'
          },
          { role: 'user', content: task }
        ],
        // 冷加载 + 生成长内容都可能很慢，但绝不能无限等；用户点停止要能立刻中止
        { timeoutMs: 120000, signal }
      )
      return {
        result: `辅助模型「${targetLabel(sub)}」的执行结果：\n${out.slice(0, 8000)}\n（请验收：不合格可修改指令重试，或由你自行完成。）`
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { result: `委派失败：${msg}。请由你自行完成该任务，不要重复委派。` }
    }
  }
  if (call.name === 'generate_image') {
    const img = resolveRole('imageGen', main)
    if (!img) return { result: '生图模型当前不可用（未配置或供应商未接入），无法生成图片。' }
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) return { result: '生图失败：prompt 为空' }
    log(`🎨 正在用 ${targetLabel(img)} 生成图片…`)
    try {
      const name = await generateImage(img, prompt)
      return {
        result: `图片已生成并保存：${name}。向用户展示时使用 Markdown 图片语法 ![生成图片](xjfile://img/${name})。`,
        images: [name]
      }
    } catch (e) {
      return { result: `生图失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return { result: `未知联合工具 ${call.name}` }
}
