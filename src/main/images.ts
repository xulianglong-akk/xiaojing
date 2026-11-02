/**
 * 图片层 —— 联合模式的图片中枢：
 * - 聊天图片（上传/粘贴）与生成图片统一存放在数据目录 images/，消息里只存文件名
 * - 生图：走 OpenAI 兼容 /images/generations（GLM cogview、OpenAI gpt-image 等）
 * - 展示：渲染层经 xjfile://img/<文件名> 协议读取（只允许纯文件名）
 * - 发给模型：读取文件转 base64 data URL（多模态消息用）
 */
import { net } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, loadSettings, getProviderKey } from './store'
import { LLMTarget } from './llm'

const imgDir = (): string => path.join(getDataDir(), 'images')

/** 只允许纯文件名（无路径分隔符、无 ..），返回完整路径；非法返回 null */
export function safeImagePath(name: string): string | null {
  if (!name || /[\\/:*?"<>|]/.test(name) || name.includes('..')) return null
  return path.join(imgDir(), name)
}

/** 保存 data URL 图片（上传/粘贴），返回文件名 */
export function saveImageDataUrl(dataUrl: string, prefix = 'up'): string {
  const m = /^data:image\/(png|jpeg|webp|gif|bmp);base64,(.+)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error('图片数据无效')
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length || buf.length > 20 * 1024 * 1024) throw new Error('图片无效或过大（上限 20MB）')
  fs.mkdirSync(imgDir(), { recursive: true })
  const name = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`
  fs.writeFileSync(path.join(imgDir(), name), buf)
  return name
}

/** 文件名 → data URL（发给多模态模型用）；文件不存在返回 null */
export function imageToDataUrl(name: string): string | null {
  const full = safeImagePath(name)
  if (!full || !fs.existsSync(full)) return null
  const buf = fs.readFileSync(full)
  const ext = path.extname(name).slice(1).toLowerCase()
  const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext || 'png'
  return `data:image/${mime};base64,${buf.toString('base64')}`
}

/** 从二进制内容推断扩展名（按魔数，识别不了给 .png） */
function extFromBuffer(buf: Buffer): string {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length > 4 && buf.slice(0, 4).toString() === 'RIFF') return 'webp'
  if (buf.length > 3 && buf.slice(0, 3).toString() === 'GIF') return 'gif'
  return 'png'
}

/**
 * 文生图：OpenAI 兼容 /images/generations。
 * 返回保存后的文件名；失败抛错（错误文本会作为工具结果回给主模型）。
 */
export async function generateImage(target: LLMTarget, prompt: string): Promise<string> {
  const s = loadSettings()
  const p = s.providers.find((x) => x.id === target.providerId)
  if (!p) throw new Error(`生图失败：未找到供应商 ${target.providerId}`)
  const key = getProviderKey(target.providerId)
  if (p.apiType === 'anthropic') throw new Error('Anthropic 暂不支持 /images/generations 生图端点，请在「联合」里换用其他生图模型')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  const url = p.baseUrl.replace(/\/$/, '') + '/images/generations'
  const body = JSON.stringify({ model: target.model, prompt, n: 1, size: '1024x1024' })

  // 个别端点不接受 size 参数：失败一次后去掉 size 重试
  let res = await net.fetch(url, { method: 'POST', headers, body })
  if (!res.ok && res.status === 400) {
    res = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: target.model, prompt, n: 1 })
    })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`生图失败 (${res.status}): ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] }
  const item = json.data?.[0]
  let buf: Buffer | null = null
  let ext = 'png'
  if (item?.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64')
    ext = extFromBuffer(buf)
  } else if (item?.url) {
    // 返回外链时下载（域名即所配置生图服务的域名，符合网络白名单）
    const dl = await net.fetch(item.url)
    if (!dl.ok) throw new Error(`生图失败：下载图片失败 (${dl.status})`)
    const ab = await dl.arrayBuffer()
    buf = Buffer.from(ab)
    const ct = dl.headers.get('content-type') ?? ''
    if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg'
    else if (ct.includes('webp')) ext = 'webp'
    else ext = extFromBuffer(buf)
  }
  if (!buf || !buf.length) throw new Error('生图失败：端点未返回图片数据')
  fs.mkdirSync(imgDir(), { recursive: true })
  const name = `gen_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${ext}`
  fs.writeFileSync(path.join(imgDir(), name), buf)
  return name
}
