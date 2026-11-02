/**
 * ComfyUI 对接层 —— 本地生图 / 生视频：
 * - 管理 ComfyUI 服务状态（探测 / 拉起 run_nvidia_gpu.bat）
 * - 模型目录：每个模型一份文件清单 + API 格式工作流构建器（与官方基准工作流同构）
 * - 生成队列：POST /prompt → 轮询 /history → /view 取回产物 → 存数据目录 images/ videos/
 * - 全程走本机 127.0.0.1，不出网
 */
import { net } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, spawnSync } from 'child_process'
import { readJSON, writeJSON, deleteFile, getDataDir, loadSettings } from './store'
import { completeOnce } from './llm'

export type GenKind = 'image' | 'video' | 'audio'

export interface GenModelDef {
  id: string
  name: string
  kind: GenKind
  desc: string
  files: string[] // 相对 ComfyUI/models/ 的路径
  defaults: Partial<GenParams>
}

export interface GenParams {
  width: number
  height: number
  seed: number
  duration: number // 秒（视频）
}

/** 模型目录：文件齐全才可选（能力校验与联合模式同一原则：不可用就不出现） */
export const GEN_MODELS: GenModelDef[] = [
  {
    id: 'z-image-turbo',
    name: 'Z-Image Turbo',
    kind: 'image',
    desc: '通义 6B · int8 量化 · 8 步出图 · 中文提示词友好',
    files: [
      'diffusion_models/z_image_turbo_int8_convrot.safetensors',
      'text_encoders/qwen_3_4b_fp8_mixed.safetensors',
      'vae/ae.safetensors'
    ],
    defaults: { width: 1024, height: 1024 }
  },
  {
    id: 'flux3-klein',
    name: 'FLUX.3 Klein',
    kind: 'image',
    desc: 'BFL 小型快速版 · int8 · 16 步 · 写实质感',
    files: [
      'diffusion_models/flux3-image-klein-int8-convrot.safetensors',
      'text_encoders/qwen3vl_4b_int8_convrot.safetensors',
      'vae/flux2-vae.safetensors'
    ],
    defaults: { width: 1024, height: 1024 }
  },
  {
    id: 'sdxl',
    name: 'SDXL 1.0',
    kind: 'image',
    desc: '经典底模 · 生态最广 · 30 步',
    files: ['checkpoints/sd_xl_base_1.0.safetensors'],
    defaults: { width: 1024, height: 1024 }
  },
  {
    id: 'ltx-2b',
    name: 'LTX-Video 2B',
    kind: 'video',
    desc: '2B 蒸馏 · Q8 · 8 步 · 最轻快的视频模型',
    files: [
      'diffusion_models/ltxv-2b-0.9.6-distilled-04-25-Q8_0.gguf',
      'text_encoders/t5xxl_fp8_e4m3fn.safetensors',
      'vae/LTX-Video-0.9.6-VAE-BF16.safetensors'
    ],
    defaults: { width: 768, height: 512, duration: 4 }
  },
  {
    id: 'minimax-h3',
    name: 'MiniMax H3',
    kind: 'video',
    desc: '大模型 · int8 · 8 步 turbo · 带音频 · 慢但质量高（内存要求高）',
    files: [
      'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
      'vae/minimax_h3_video_vae_int8_convrot.safetensors',
      'vae/minimax_h3_audio_vae_fp32.safetensors',
      'loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
    ],
    defaults: { width: 768, height: 432, duration: 5 }
  },
  {
    id: 'acestep-15-turbo',
    name: 'ACE-Step 1.5',
    kind: 'audio',
    desc: '音乐生成 · XL Turbo · 8 步 · 描述风格与氛围即可出歌',
    files: [
      'diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors',
      'text_encoders/qwen_0.6b_ace15.safetensors',
      'text_encoders/qwen_4b_ace15.safetensors',
      'vae/ace_1.5_vae.safetensors'
    ],
    defaults: { duration: 60 }
  }
]

export interface GenModelInfo extends GenModelDef {
  ready: boolean
  missing: string[]
}

function comfyConf(): { dir: string; port: number } {
  const s = loadSettings()
  return { dir: s.comfyDir || 'E:\\ComfyUI', port: s.comfyPort || 8188 }
}

export function modelsDir(): string {
  return path.join(comfyConf().dir, 'ComfyUI', 'models')
}

export function listGenModels(): GenModelInfo[] {
  const dir = modelsDir()
  return GEN_MODELS.map((m) => {
    const missing = m.files.filter((f) => !fs.existsSync(path.join(dir, f)))
    return { ...m, ready: missing.length === 0, missing }
  })
}

// ---------- 服务状态 ----------

const base = (): string => `http://127.0.0.1:${comfyConf().port}`

export async function comfyStatus(): Promise<{ running: boolean; version?: string }> {
  try {
    const res = await net.fetch(base() + '/system_stats', { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return { running: false }
    const json = (await res.json()) as { system?: { comfyui_version?: string } }
    return { running: true, version: json.system?.comfyui_version }
  } catch {
    return { running: false }
  }
}

let comfyProc: ReturnType<typeof spawn> | null = null

/** 本进程拉起（而非用户自己开的）的 ComfyUI 进程 PID；退出时据此收尾，不动别人的服务 */
export function startedComfyPid(): number | null {
  return comfyProc?.pid ?? null
}

/** 拉起便携版 ComfyUI（run_nvidia_gpu.bat），等待端口就绪 */
let comfyStarting: Promise<boolean> | null = null

export async function startComfy(): Promise<boolean> {
  if (await comfyStatus().then((s) => s.running)) return true
  // 并发防护：聊天工具/生成页同时触发启动时只拉起一次
  if (comfyStarting) return comfyStarting
  comfyStarting = doStartComfy()
  try {
    return await comfyStarting
  } finally {
    comfyStarting = null
  }
}

async function doStartComfy(): Promise<boolean> {
  const { dir } = comfyConf()
  const bat = path.join(dir, 'run_nvidia_gpu.bat')
  if (!fs.existsSync(bat)) throw new Error(`未找到 ${bat}，请确认 ComfyUI 便携版安装位置`)
  comfyProc = spawn('cmd.exe', ['/c', bat], { cwd: dir, windowsHide: true })
  comfyProc.on('exit', () => (comfyProc = null))
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    if (await comfyStatus().then((s) => s.running)) return true
  }
  throw new Error('ComfyUI 启动超时（2 分钟），请手动运行 run_nvidia_gpu.bat 查看报错')
}

// ---------- 会话与消息 ----------

export interface GenMsg {
  id: string
  role: 'user' | 'result'
  prompt: string
  modelId?: string
  params?: GenParams
  images?: string[] // images/ 下的文件名
  video?: string // videos/ 下的文件名
  audio?: string // audio/ 下的文件名
  meta?: string // 模型 · 尺寸 · 耗时等说明行
  error?: string
  ts: number
}

export interface GenSession {
  id: string
  kind: GenKind
  title: string
  createdAt: number
  modelId?: string // 会话绑定的默认模型
}

const sessionsFile = 'gen/sessions.json'

export function listGenSessions(kind?: GenKind): GenSession[] {
  const all = readJSON<GenSession[]>(sessionsFile, [])
  return all
    .filter((s) => !kind || s.kind === kind)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function saveGenSessions(list: GenSession[]): void {
  writeJSON(sessionsFile, list)
}

export function createGenSession(kind: GenKind, modelId?: string): GenSession {
  const s: GenSession = {
    id: 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind,
    title: '新作品',
    createdAt: Date.now(),
    modelId
  }
  const list = readJSON<GenSession[]>(sessionsFile, [])
  list.push(s)
  saveGenSessions(list)
  return s
}

export function updateGenSession(id: string, patch: Partial<GenSession>): GenSession {
  const list = readJSON<GenSession[]>(sessionsFile, [])
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) throw new Error('会话不存在')
  list[i] = { ...list[i], ...patch }
  saveGenSessions(list)
  return list[i]
}

export function deleteGenSession(id: string): void {
  // 先读消息、把产物文件名收齐，再删索引——否则「删掉作品」只删了列表项，
  // 图片/视频/音频还躺在数据目录里占空间（用户也不会想到去手删）
  const msgs = getGenMessages(id)
  saveGenSessions(listGenSessions().filter((x) => x.id !== id))
  deleteFile(`gen/${id}.json`)
  for (const m of msgs) {
    for (const n of m.images ?? []) deleteFile(`images/${n}`)
    if (m.video) deleteFile(`videos/${m.video}`)
    if (m.audio) deleteFile(`audio/${m.audio}`)
  }
}

/**
 * 清理孤儿作品：`gen/` 里已经不在索引中的 json，连同它们引用的产物一起删。
 * 删除时文件恰好被占用就会留下这种残留——索引已经没了，界面上看不到，磁盘却一直占着。
 * 启动时跑一次，属于兜底。
 */
export function cleanupOrphanGenFiles(): void {
  const dir = path.join(getDataDir(), 'gen')
  if (!fs.existsSync(dir)) return
  const known = new Set(listGenSessions().map((s) => s.id))
  let cleaned = 0
  for (const f of fs.readdirSync(dir)) {
    if (f === 'sessions.json' || !f.endsWith('.json')) continue
    const id = f.slice(0, -'.json'.length)
    if (known.has(id)) continue
    try {
      const msgs = readJSON<GenMsg[]>(`gen/${f}`, [])
      for (const m of msgs) {
        for (const n of m.images ?? []) deleteFile(`images/${n}`)
        if (m.video) deleteFile(`videos/${m.video}`)
        if (m.audio) deleteFile(`audio/${m.audio}`)
      }
      deleteFile(`gen/${f}`)
      cleaned++
    } catch {
      /* 删不掉就下次启动再试 */
    }
  }
  if (cleaned) console.log(`[cleanup] 清理了 ${cleaned} 个孤儿作品记录`)
}

export function getGenMessages(sessionId: string): GenMsg[] {
  return readJSON<GenMsg[]>(`gen/${sessionId}.json`, [])
}

function saveGenMessages(sessionId: string, msgs: GenMsg[]): void {
  writeJSON(`gen/${sessionId}.json`, msgs)
}

// ---------- 工作流构建（API 格式，与官方基准工作流同构） ----------

type WFNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }
type WF = Record<string, WFNode>

/** H3 帧数公式（官方基准）：max(5, round(d*24)) 再补齐到 %17 合法 */
function h3Frames(d: number): number {
  const n = Math.max(5, Math.round(d * 24))
  return n + ((5 - (n % 17)) % 17)
}

/** LTX 帧数：时长 × 24fps，取奇数 */
function ltxFrames(d: number): number {
  let n = Math.round(d * 24) + 1
  if (n % 2 === 0) n += 1
  return n
}

export function buildWorkflow(def: GenModelDef, p: GenParams, prompt: string): WF {
  const negImg = ''
  // files 存相对路径（供存在性检查），节点入参只要纯文件名
  const f = def.files.map((x) => path.basename(x))
  switch (def.id) {
    case 'z-image-turbo':
      return {
        unet: { class_type: 'UNETLoader', inputs: { unet_name: f[0], weight_dtype: 'default' } },
        ms: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, sampling: 'flow', model: ['unet', 0] } },
        clip: { class_type: 'CLIPLoader', inputs: { clip_name: f[1], type: 'lumina2', device: 'default' } },
        vae: { class_type: 'VAELoader', inputs: { vae_name: f[2] } },
        pos: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['clip', 0] } },
        neg: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } },
        lat: { class_type: 'EmptySD3LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
        ks: {
          class_type: 'KSampler',
          inputs: {
            seed: p.seed, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
            model: ['ms', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0]
          }
        },
        dec: { class_type: 'VAEDecode', inputs: { samples: ['ks', 0], vae: ['vae', 0] } },
        save: { class_type: 'SaveImage', inputs: { filename_prefix: 'xiaojing', images: ['dec', 0] } }
      }
    case 'flux3-klein':
      return {
        unet: { class_type: 'UNETLoader', inputs: { unet_name: f[0], weight_dtype: 'default' } },
        clip: { class_type: 'CLIPLoader', inputs: { clip_name: f[1], type: 'flux3', device: 'default' } },
        vae: { class_type: 'VAELoader', inputs: { vae_name: f[2] } },
        pos: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['clip', 0] } },
        neg: { class_type: 'CLIPTextEncode', inputs: { text: negImg, clip: ['clip', 0] } },
        pf: { class_type: 'PrimitiveFloat', inputs: { value: 16 } },
        math: { class_type: 'ComfyMathExpression', inputs: { expression: 'log(a)', 'values.a': ['pf', 0] } },
        msf: { class_type: 'ModelSamplingFlux', inputs: { model: ['unet', 0], max_shift: ['math', 0], base_shift: ['math', 0], width: p.width, height: p.height } },
        lat: { class_type: 'EmptyFlux2LatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
        ks: {
          class_type: 'KSampler',
          inputs: {
            seed: p.seed, steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
            model: ['msf', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0]
          }
        },
        dec: { class_type: 'VAEDecode', inputs: { samples: ['ks', 0], vae: ['vae', 0] } },
        save: { class_type: 'SaveImage', inputs: { filename_prefix: 'xiaojing', images: ['dec', 0] } }
      }
    case 'sdxl':
      return {
        ck: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: f[0] } },
        pos: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['ck', 1] } },
        neg: {
          class_type: 'CLIPTextEncode',
          inputs: {
            text:
              'low quality, worst quality, blurry, watermark, text, deformed hands, extra fingers, fused fingers, missing fingers, malformed limbs, bad anatomy, extra limbs, mutated hands, poorly drawn face',
            clip: ['ck', 1]
          }
        },
        lat: { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
        ks: {
          class_type: 'KSampler',
          inputs: {
            seed: p.seed, steps: 30, cfg: 6.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['ck', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0]
          }
        },
        dec: { class_type: 'VAEDecode', inputs: { samples: ['ks', 0], vae: ['ck', 2] } },
        save: { class_type: 'SaveImage', inputs: { filename_prefix: 'xiaojing', images: ['dec', 0] } }
      }
    case 'ltx-2b': {
      const frames = ltxFrames(p.duration)
      return {
        unet: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: f[0] } },
        clip: { class_type: 'CLIPLoader', inputs: { clip_name: f[1], type: 'ltxv', device: 'default' } },
        vae: { class_type: 'VAELoader', inputs: { vae_name: f[2] } },
        pos: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['clip', 0] } },
        neg: {
          class_type: 'CLIPTextEncode',
          inputs: { text: 'low quality, worst quality, deformed, distorted, disfigured, motion smear, motion artifacts', clip: ['clip', 0] }
        },
        cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: 25 } },
        lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: p.width, height: p.height, length: frames, batch_size: 1 } },
        sched: { class_type: 'LTXVScheduler', inputs: { steps: 8, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1 } },
        sel: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'lcm' } },
        samp: {
          class_type: 'SamplerCustom',
          inputs: {
            model: ['unet', 0], add_noise: true, noise_seed: p.seed, cfg: 1,
            positive: ['cond', 0], negative: ['cond', 1], sampler: ['sel', 0], sigmas: ['sched', 0], latent_image: ['lat', 0]
          }
        },
        dec: { class_type: 'VAEDecode', inputs: { samples: ['samp', 0], vae: ['vae', 0] } },
        // codec 必须 h264：默认 auto 编码路径有色彩通道 bug（绿屏），实测 h264 正常
        cv: { class_type: 'CreateVideo', inputs: { images: ['dec', 0], fps: 25, codec: 'h264' } },
        save: { class_type: 'SaveVideo', inputs: { filename_prefix: 'xiaojing', format: 'auto', 'format.codec': 'auto', video: ['cv', 0] } }
      }
    }
    case 'minimax-h3': {
      const frames = h3Frames(p.duration)
      return {        unet: { class_type: 'UNETLoader', inputs: { unet_name: f[0], weight_dtype: 'default' } },
        lora: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: f[4], strength_model: 1, model: ['unet', 0] } },
        clip: { class_type: 'CLIPLoader', inputs: { clip_name: f[1], type: 'minimax', device: 'default' } },
        vvae: { class_type: 'VAELoader', inputs: { vae_name: f[2] } },
        avae: { class_type: 'VAELoader', inputs: { vae_name: f[3] } },
        res: { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 0.4, multiple: 32 } },
        flen: { class_type: 'PrimitiveInt', inputs: { value: frames } },
        i2v: {
          class_type: 'MiniMaxH3ImageToVideo',
          inputs: { prompt, width: ['res', 0], height: ['res', 1], length: ['flen', 0], clip: ['clip', 0], vae: ['vvae', 0] }
        },
        steps: { class_type: 'PrimitiveInt', inputs: { value: 8 } },
        sched: { class_type: 'BasicScheduler', inputs: { scheduler: 'simple', steps: ['steps', 0], denoise: 1, model: ['lora', 0] } },
        sel: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
        noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
        guider: { class_type: 'BasicGuider', inputs: { model: ['lora', 0], conditioning: ['i2v', 0] } },
        samp: {
          class_type: 'SamplerCustomAdvanced',
          inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sel', 0], sigmas: ['sched', 0], latent_image: ['i2v', 1] }
        },
        vdec: { class_type: 'VAEDecode', inputs: { samples: ['samp', 0], vae: ['vvae', 0] } },
        adec: { class_type: 'VAEDecodeAudio', inputs: { samples: ['samp', 0], vae: ['avae', 0] } },
        cv: { class_type: 'CreateVideo', inputs: { fps: 24, bit_depth: 8, color_space: 'sRGB', codec: 'h264', images: ['vdec', 0], audio: ['adec', 0] } },
        save: { class_type: 'SaveVideo', inputs: { filename_prefix: 'xiaojing', format: 'auto', 'format.codec': 'auto', codec: 'auto', video: ['cv', 0] } }
      }
    }
    case 'acestep-15-turbo':
      return {
        unet: { class_type: 'UNETLoader', inputs: { unet_name: f[0], weight_dtype: 'default' } },
        ms: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, sampling: 'flow', model: ['unet', 0] } },
        clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: f[1], clip_name2: f[2], type: 'ace', device: 'default' } },
        vae: { class_type: 'VAELoader', inputs: { vae_name: f[3] } },
        txt: {
          class_type: 'TextEncodeAceStepAudio1.5',
          inputs: {
            clip: ['clip', 0],
            tags: prompt,
            lyrics: '',
            seed: p.seed,
            bpm: 100,
            duration: p.duration,
            timesignature: '4',
            language: 'zh',
            keyscale: 'C major',
            generate_audio_codes: true,
            cfg_scale: 2,
            temperature: 0.85,
            top_p: 0.9,
            top_k: 0,
            min_p: 0
          }
        },
        neg: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['txt', 0] } },
        lat: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: p.duration, batch_size: 1 } },
        ks: {
          class_type: 'KSampler',
          inputs: {
            seed: p.seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
            model: ['ms', 0], positive: ['txt', 0], negative: ['neg', 0], latent_image: ['lat', 0]
          }
        },
        adec: { class_type: 'VAEDecodeAudio', inputs: { samples: ['ks', 0], vae: ['vae', 0] } },
        save: { class_type: 'SaveAudioAdvanced', inputs: { filename_prefix: 'xiaojing', format: 'mp3', 'format.quality': 'V0', audio: ['adec', 0] } }
      }
    default:
      throw new Error(`未知模型 ${def.id}`)
  }
}

// ---------- 生成执行 ----------

const activeGens = new Map<string, { abort: boolean }>()

export function stopGen(sessionId: string): void {
  const g = activeGens.get(sessionId)
  if (g) g.abort = true
  net
    .fetch(base() + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(3000) })
    .catch(() => {})
}

/** 正在生成的作品。渲染层切页回来靠它恢复进度，避免重复提交同一个任务 */
export function activeGenSessions(): string[] {
  return [...activeGens.keys()]
}

// ---------- 供聊天 / Codex / 机器人调用的统一生成入口 ----------

/** 视频模型的文本编码器基本只懂英文——中文提示词进去轻则跑偏重则完全无关
 *  （实测 LTX/T5-XXL 中文=噪声；H3 中文偶尔碰对但「咖啡杯特写」整条跑偏）。
 *  含中文的视频提示词先用默认模型译成英文，失败回落原文；Z-Image/H3编码器的中文生图不受影响。 */
const VIDEO_EN_MODELS = new Set(['ltx-2b', 'minimax-h3'])

/** 译文里残留的中文占比（只有「几乎全中文」才算翻译失败）——
 *  小模型常把专有名词原样留下（如 "A柴犬 wearing sunglasses…"），
 *  以前用「出现任何汉字就判失败」导致整句回落成中文原文，视频必跑偏 */
function cjkRatio(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (s.match(/[A-Za-z]/g) || []).length
  if (!latin && !cjk) return 0
  return cjk / (cjk + latin)
}

async function ensureEnglishPrompt(modelId: string, prompt: string): Promise<string> {
  if (!VIDEO_EN_MODELS.has(modelId) || !/[\u4e00-\u9fff]/.test(prompt)) return prompt
  const s = loadSettings()
  const ask = (p: string) =>
    completeOnce(
      { providerId: s.defaultProviderId, model: s.defaultModel },
      [
        {
          role: 'user',
          content:
            '把下面的视频画面描述翻译成英文的视频生成提示词（保留镜头运动、主体动作、氛围细节，直接输出英文译文，不要任何解释）：\n' +
            p
        }
      ],
      { temperature: 0.2, maxTokens: 300 }
    ).then((out) => out.trim().replace(/^["'「」]|["'「」]$/g, ''))
  try {
    const t = await ask(prompt)
    if (t && /[A-Za-z]{3}/.test(t)) {
      // 零残留汉字：直接用
      if (cjkRatio(t) === 0) return t
      // 有残留（专有名词常被小模型原样留下，如 "A柴犬 wearing…"）：再逼一次全英文重写，
      // 只要第二遍更干净就用第二遍，否则退回第一遍（少量汉字仍远好于整句中文）
      const t2 = await ask(
        `Rewrite this in English only, translate every Chinese word (including names) into English. Output the English prompt only:\n${t}`
      )
      if (t2 && /[A-Za-z]{3}/.test(t2) && cjkRatio(t2) < cjkRatio(t)) return t2
      if (cjkRatio(t) < 0.15) return t
    }
  } catch {
    /* 翻译失败回落原文 */
  }
  return prompt
}

/** 各类型的首选模型（agent 场景优先快的小模型） */
const PREFERRED = { image: 'z-image-turbo', video: 'ltx-2b', audio: 'acestep-15-turbo' }

export interface QuickGenResult {
  kind: GenKind
  fileName: string
  meta: string
}

/**
 * 一次性生成（无会话）：自动启动 ComfyUI、选首选就绪模型、提交并等结果。
 * 供聊天 / Codex / 机器人的工具调用使用。
 */
export async function quickGenerate(
  kind: GenKind,
  prompt: string,
  opts?: { duration?: number; width?: number; height?: number },
  log?: (t: string) => void
): Promise<QuickGenResult> {
  const st = await comfyStatus()
  if (!st.running) {
    log?.('正在启动本地 ComfyUI 生成服务…')
    await startComfy()
  }
  const infos = listGenModels().filter((m) => m.kind === kind && m.ready)
  if (!infos.length) throw new Error(`本地没有就绪的${kind === 'image' ? '生图' : kind === 'video' ? '生视频' : '生音乐'}模型（文件未下全）`)
  const def = infos.find((m) => m.id === PREFERRED[kind]) ?? infos[0]
  const params: GenParams = {
    width: opts?.width ?? def.defaults.width ?? 1024,
    height: opts?.height ?? def.defaults.height ?? 1024,
    duration: opts?.duration ?? def.defaults.duration ?? 5,
    seed: Math.floor(Math.random() * 1e15)
  }
  const t0 = Date.now()
  const wfPrompt = await ensureEnglishPrompt(def.id, prompt)
  if (wfPrompt !== prompt) log?.(`提示词已译为英文（${def.name} 仅支持英文）：${wfPrompt}`)
  else if (VIDEO_EN_MODELS.has(def.id) && cjkRatio(prompt) > 0.15)
    log?.(`⚠ 提示词没能译成英文，${def.name} 对中文不可靠，画面可能跑偏`)
  const wf = buildWorkflow(def, params, wfPrompt)
  const res = await net.fetch(base() + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'xiaojing-agent' })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`ComfyUI 拒绝任务 (${res.status}): ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as { prompt_id?: string }
  if (!json.prompt_id) throw new Error('ComfyUI 未返回任务 ID')
  let outputs: Record<string, { images?: ComfyOutputItem[]; videos?: ComfyOutputItem[]; audio?: ComfyOutputItem[] }> | null = null
  for (let i = 0; i < 1500; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const h = await net.fetch(base() + `/history/${json.prompt_id}`, { signal: AbortSignal.timeout(6000) }).catch(() => null)
    if (!h || !h.ok) continue
    const hj = (await h.json()) as Record<string, { status?: { completed: boolean; status_str?: string }; outputs?: typeof outputs }>
    const rec = hj[json.prompt_id]
    if (!rec) continue
    if (rec.status?.completed) {
      outputs = rec.outputs ?? {}
      break
    }
    if (rec.status?.status_str === 'error') throw new Error('本地生成失败（节点执行出错）')
    if (i % 15 === 0) log?.(`本地生成中… ${i * 2}s`)
  }
  if (!outputs) throw new Error('本地生成超时')
  let fileName = ''
  for (const nodeOut of Object.values(outputs)) {
    const it = nodeOut?.audio?.[0] ?? nodeOut?.videos?.[0] ?? nodeOut?.images?.[0]
    if (!it) continue
    const dest: 'images' | 'videos' | 'audio' =
      kind === 'audio' ? 'audio' : kind === 'video' ? 'videos' : 'images'
    fileName = await fetchOutput(it, dest)
  }
  if (!fileName) throw new Error('生成完成但没有产物')
  const secs = Math.round((Date.now() - t0) / 1000)
  return { kind, fileName, meta: `${def.name} · ${secs}s` }
}

/** 本地生成工具定义（给聊天 / Codex / 机器人的 LLM 工具清单；哪类就绪才出现哪类） */
export function mediaToolDefs(): unknown[] {
  const ready = new Set(listGenModels().filter((m) => m.ready).map((m) => m.kind))
  const defs: unknown[] = []
  if (ready.has('image')) {
    defs.push({
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          '用本地模型生成一张图片（免费，约 20-60 秒）。仅当用户明确想要一张图片/插画/配图时使用；用户只是提问、讨论或闲聊时不要调用。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '图片描述（主体+场景+风格+光线，越具体越好）' },
            width: { type: 'number', description: '宽（默认 1024）' },
            height: { type: 'number', description: '高（默认 1024）' }
          },
          required: ['prompt']
        }
      }
    })
  }
  if (ready.has('video')) {
    defs.push({
      type: 'function',
      function: {
        name: 'generate_video',
        description:
          '用本地模型生成一段无声/有声短视频（免费，约 1-10 分钟，较慢）。仅当用户明确要视频时使用；轻易不要调用，拿不准时先问用户。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '动态画面描述（镜头运动+主体动作+氛围）' },
            duration: { type: 'number', description: '时长秒数（3-10）' }
          },
          required: ['prompt']
        }
      }
    })
  }
  if (ready.has('audio')) {
    defs.push({
      type: 'function',
      function: {
        name: 'generate_music',
        description:
          '用本地模型生成一段音乐/配乐（免费，约 1-5 分钟）。仅当用户明确要音乐、BGM、音效时使用。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '音乐描述（风格+BPM+乐器+情绪）' },
            duration: { type: 'number', description: '时长秒数（30-180）' }
          },
          required: ['prompt']
        }
      }
    })
  }
  return defs
}

/** 执行本地生成工具，返回给模型的文本结果 */
export async function execMediaTool(
  call: { name: string; arguments: string },
  log?: (t: string) => void
): Promise<{ result: string; fileName?: string; kind?: GenKind }> {
  let args: any = {}
  try {
    args = JSON.parse(call.arguments || '{}')
  } catch {
    return { result: '参数解析失败' }
  }
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return { result: 'prompt 为空，无法生成' }
  const kind: GenKind | null =
    call.name === 'generate_image' ? 'image' : call.name === 'generate_video' ? 'video' : call.name === 'generate_music' ? 'audio' : null
  if (!kind) return { result: `未知工具 ${call.name}` }
  try {
    const r = await quickGenerate(kind, prompt, { duration: args.duration, width: args.width, height: args.height }, log)
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音乐'
    return {
      result: `${label}已生成并直接展示给用户（${r.meta}）。在回复中简短介绍生成内容即可，不要罗列文件名。`,
      fileName: r.fileName,
      kind: r.kind
    }
  } catch (e) {
    return { result: `本地生成失败：${e instanceof Error ? e.message : String(e)}。请向用户说明，不要谎称已生成。` }
  }
}

/**
 * 能力认知提示（何时该用 / 不该用）——注入聊天、Codex、机器人的 system。
 * 有任一就绪模型才注入。
 */
export function mediaCapabilitiesPrompt(): string | null {
  const ready = new Set(listGenModels().filter((m) => m.ready).map((m) => m.kind))
  if (!ready.size) return null
  const lines: string[] = ['【本地生成能力】你连接着一台本地生成服务（ComfyUI，免费、离线），可以：']
  if (ready.has('image')) lines.push('- generate_image：生成图片，约 20-60 秒')
  if (ready.has('video')) lines.push('- generate_video：生成短视频，约 1-10 分钟（慢，慎用）')
  if (ready.has('audio')) lines.push('- generate_music：生成音乐/配乐，约 1-5 分钟')
  lines.push(
    '使用原则（重要）：',
    '1) 只有用户明确想要「生成一张图 / 来段音乐 / 做个视频」这类意图时才调用工具；',
    '2) 用户在提问、讨论、闲聊、或只是「想象一下」的修辞 → 用文字回答，绝不调用；',
    '3) 用户要的是真实照片、截图、已有文件 → 你生成不了，如实说明；',
    '4) 生成耗时不短，同一轮最多生成一次；意图模糊时先跟用户确认再生成；',
    '5) 生成结果会自动展示给用户，回复时简短说明画面/内容构思即可，不要重复文件路径。'
  )
  return lines.join('\n')
}


export interface GenSendOptions {
  sessionId: string
  modelId: string
  prompt: string
  width?: number
  height?: number
  duration?: number
  emit: (event: { type: string; [k: string]: unknown }) => void
}

interface ComfyOutputItem {
  filename: string
  subfolder?: string
  type?: string
  /** SaveVideo 的输出带 format 信息 */
  format?: string
}

function extOf(filename: string, fmt?: string): string {
  const e = path.extname(filename).replace('.', '').toLowerCase()
  if (e) return e
  if (fmt?.includes('webp')) return 'webp'
  if (fmt?.includes('gif')) return 'gif'
  return 'png'
}

export async function runGeneration(opts: GenSendOptions): Promise<void> {
  const { sessionId, emit } = opts
  const emitS = (e: { type: string; [k: string]: unknown }): void => emit({ ...e, sessionId })
  const session = listGenSessions().find((x) => x.id === sessionId)
  if (!session) {
    emitS({ type: 'error', message: '会话不存在' })
    return
  }
  const def = GEN_MODELS.find((m) => m.id === opts.modelId)
  if (!def) {
    emitS({ type: 'error', message: `未知模型 ${opts.modelId}` })
    return
  }
  const info = listGenModels().find((m) => m.id === def.id)
  if (!info?.ready) {
    emitS({ type: 'error', message: `模型文件不完整（缺 ${info?.missing[0] ?? '?'}），请在设置-生图视频中查看` })
    return
  }
  const st = await comfyStatus()
  if (!st.running) {
    emitS({ type: 'status', text: 'ComfyUI 未运行，正在启动…' })
    try {
      await startComfy()
    } catch (e) {
      emitS({ type: 'error', message: e instanceof Error ? e.message : String(e) })
      emitS({ type: 'end' })
      return
    }
  }

  const params: GenParams = {
    width: opts.width ?? def.defaults.width ?? 1024,
    height: opts.height ?? def.defaults.height ?? 1024,
    duration: opts.duration ?? def.defaults.duration ?? 5,
    seed: Math.floor(Math.random() * 1e15)
  }
  const msgId = 'gm_' + Date.now().toString(36)
  const userMsg: GenMsg = { id: msgId + '_u', role: 'user', prompt: opts.prompt, modelId: def.id, params, ts: Date.now() }
  const resultMsg: GenMsg = { id: msgId, role: 'result', prompt: opts.prompt, modelId: def.id, params, ts: Date.now() }
  try {
    saveGenMessages(sessionId, [...getGenMessages(sessionId), userMsg, resultMsg])
    emitS({ type: 'user-saved', message: userMsg })
  } catch (e) {
    emitS({ type: 'error', message: '任务入队失败：' + (e instanceof Error ? e.message : String(e)) })
    emitS({ type: 'end' })
    return
  }

  const state = { abort: false }
  activeGens.set(sessionId, state)
  const t0 = Date.now()
  try {
    const wfPrompt = await ensureEnglishPrompt(def.id, opts.prompt)
    if (wfPrompt !== opts.prompt)
      emitS({ type: 'status', text: `提示词已译为英文（${def.name} 仅支持英文）…` })
    else if (VIDEO_EN_MODELS.has(def.id) && cjkRatio(opts.prompt) > 0.15)
      emitS({ type: 'status', text: `⚠ 提示词没能译成英文，${def.name} 对中文不可靠，画面可能跑偏…` })
    const wf = buildWorkflow(def, params, wfPrompt)
    emitS({
      type: 'status',
      text:
        def.kind === 'audio'
          ? `正在生成（${def.name} · ${params.duration}s）…`
          : `正在生成（${def.name} · ${params.width}×${params.height}）…`
    })
    const res = await net.fetch(base() + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: 'xiaojing' })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ComfyUI 拒绝任务 (${res.status}): ${text.slice(0, 400)}`)
    }
    const json = (await res.json()) as { prompt_id?: string }
    if (!json.prompt_id) throw new Error('ComfyUI 未返回任务 ID')

    // 轮询 history 直到完成
    let outputs: Record<
      string,
      { images?: ComfyOutputItem[]; gifs?: ComfyOutputItem[]; videos?: ComfyOutputItem[]; audio?: ComfyOutputItem[] }
    > | null = null
    let failMsg = ''
    for (let i = 0; i < 2400; i++) {
      if (state.abort) throw new Error('已停止')
      await new Promise((r) => setTimeout(r, 1500))
      const h = await net.fetch(base() + `/history/${json.prompt_id}`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (!h || !h.ok) continue
      const hj = (await h.json()) as Record<string, { status?: { completed: boolean; status_str?: string }; outputs?: typeof outputs }>
      const rec = hj[json.prompt_id]
      if (!rec) continue
      if (rec.status?.completed) {
        outputs = rec.outputs ?? {}
        break
      }
      if (rec.status?.status_str === 'error') {
        failMsg = '生成失败（节点执行出错）'
        break
      }
    }
    if (!outputs) throw new Error(failMsg || '生成超时（60 分钟）')

    // 收集产物（images / gifs / videos / audio）
    const images: string[] = []
    let video: string | undefined
    let audio: string | undefined
    for (const nodeOut of Object.values(outputs)) {
      for (const it of nodeOut?.images ?? []) {
        if (it.type !== 'output' && it.type !== 'temp') continue
        if (def.kind === 'video' && /\.(mp4|webm|webp|gif)$/i.test(it.filename)) {
          video = await fetchOutput(it, 'videos')
        } else {
          images.push(await fetchOutput(it, 'images'))
        }
      }
      for (const it of nodeOut?.videos ?? []) {
        video = await fetchOutput(it, 'videos')
      }
      for (const it of nodeOut?.gifs ?? []) {
        if (def.kind === 'video') video = await fetchOutput(it, 'videos')
        else images.push(await fetchOutput(it, 'images'))
      }
      for (const it of nodeOut?.audio ?? []) {
        audio = await fetchOutput(it, 'audio')
      }
    }
    if (!images.length && !video && !audio) throw new Error('生成完成但没有产物文件')

    const secs = Math.round((Date.now() - t0) / 1000)
    const meta =
      def.kind === 'audio'
        ? `${def.name} · ${params.duration}s · seed ${params.seed} · ${secs}s`
        : `${def.name} · ${params.width}×${params.height}` + (def.kind === 'video' ? ` · ${params.duration}s` : '') + ` · seed ${params.seed} · ${secs}s`
    const msgs = getGenMessages(sessionId)
    const i = msgs.findIndex((m) => m.id === msgId)
    if (i >= 0) {
      msgs[i] = { ...msgs[i], images: images.length ? images : undefined, video, audio, meta }
      saveGenMessages(sessionId, msgs)
    }
    emitS({ type: 'done', message: msgs[i], images, video, audio, meta })
    // 自动改标题
    const sess = listGenSessions().find((x) => x.id === sessionId)
    if (sess && sess.title === '新作品') {
      updateGenSession(sessionId, { title: opts.prompt.slice(0, 18) })
      emitS({ type: 'session-title', title: opts.prompt.slice(0, 18) })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const msgs = getGenMessages(sessionId)
    const i = msgs.findIndex((m) => m.id === msgId)
    if (i >= 0) {
      msgs[i] = { ...msgs[i], error: message }
      saveGenMessages(sessionId, msgs)
    }
    emitS({ type: 'error', message })
  } finally {
    activeGens.delete(sessionId)
    emitS({ type: 'end' })
  }
}

/** 从 ComfyUI /view 取回产物，落盘到数据目录 images/ videos/ audio/，返回文件名 */
async function fetchOutput(it: ComfyOutputItem, destDir: 'images' | 'videos' | 'audio'): Promise<string> {
  const q = new URLSearchParams({ filename: it.filename, subfolder: it.subfolder ?? '', type: it.type ?? 'output' })
  const res = await net.fetch(base() + `/view?${q.toString()}`, { signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`取回产物失败 (${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  const dir = path.join(getDataDir(), destDir)
  fs.mkdirSync(dir, { recursive: true })
  const name = `gen_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${extOf(it.filename, it.format)}`
  fs.writeFileSync(path.join(dir, name), buf)
  // ComfyUI 写出的 AAC 音轨 Chromium 播不了（H3 带音频视频全灭），ffmpeg 重编码音频可修复
  if (destDir === 'videos' && name.endsWith('.mp4')) await remuxVideo(path.join(dir, name))
  return name
}

let ffmpegCache: string | null | undefined

/** 找可用的 ffmpeg：优先 ComfyUI 便携包自带的（imageio_ffmpeg），其次系统 PATH */
function findFfmpeg(): string | null {
  if (ffmpegCache !== undefined) return ffmpegCache
  const cand = path.join(comfyConf().dir, 'python_embeded', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
  try {
    const hit = fs.readdirSync(cand).find((f) => /^ffmpeg.*\.exe$/i.test(f))
    if (hit) {
      ffmpegCache = path.join(cand, hit)
      return ffmpegCache
    }
  } catch {
    /* 目录不存在，继续 */
  }
  try {
    // spawn('ffmpeg', ['-version']) 在 Windows 会搜 PATH
    const ok = spawnSync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true }).status === 0
    ffmpegCache = ok ? 'ffmpeg' : null
  } catch {
    ffmpegCache = null
  }
  return ffmpegCache
}

/** 视频流 copy、音频重编码 AAC。失败/无 ffmpeg 时保留原文件（LTX 无音轨不受影响）
 *  注意：不能加 +faststart——实测 moov 前置的 ffmpeg 封装在本应用 xjfile 协议栈上播不了，moov 在尾反而正常 */
async function remuxVideo(file: string): Promise<void> {
  const ff = findFfmpeg()
  if (!ff) return
  const tmp = file + '.remux.mp4'
  const args = ['-y', '-i', file, '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', tmp]
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(ff, args, { windowsHide: true, stdio: 'ignore' })
    const t = setTimeout(() => {
      p.kill()
      resolve(false)
    }, 60000)
    p.on('error', () => {
      clearTimeout(t)
      resolve(false)
    })
    p.on('close', (code) => {
      clearTimeout(t)
      resolve(code === 0)
    })
  })
  if (ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 1000) fs.renameSync(tmp, file)
  else try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
}
