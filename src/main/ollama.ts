/**
 * Ollama 本地模型管理 —— 状态检测、模型列表、拉取（进度回调）。
 * 安装引导：下载官方安装包静默安装到自选目录，数据模型目录用 OLLAMA_MODELS 指定。
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const OLLAMA_BASE = 'http://localhost:11434'

export async function ollamaStatus(): Promise<{ running: boolean; models: { name: string; size: number }[] }> {
  try {
    const res = await fetch(OLLAMA_BASE + '/api/tags', { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { running: false, models: [] }
    const json = await res.json()
    return {
      running: true,
      models: (json.models ?? []).map((m: any) => ({ name: m.name, size: m.size ?? 0 }))
    }
  } catch {
    return { running: false, models: [] }
  }
}

/** 当前已加载进内存/显存的模型（/api/ps）。用于判断「再调一个模型」会不会触发冷加载 */
export async function ollamaLoaded(): Promise<{ name: string; size: number }[]> {
  try {
    const res = await fetch(OLLAMA_BASE + '/api/ps', { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return []
    const json = await res.json()
    return (json.models ?? []).map((m: any) => ({ name: m.name, size: m.size ?? 0 }))
  } catch {
    return []
  }
}

export async function pullModel(
  model: string,
  emit: (e: { status?: string; percent?: number; done?: boolean; error?: string }) => void
): Promise<void> {
  const res = await fetch(OLLAMA_BASE + '/api/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true })
  })
  if (!res.ok || !res.body) {
    emit({ error: `拉取失败 (${res.status})，请确认 Ollama 正在运行` })
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const json = JSON.parse(line)
        if (json.error) emit({ error: json.error })
        else if (json.status && json.total && json.completed) {
          emit({ status: json.status, percent: Math.round((json.completed / json.total) * 100) })
        } else if (json.status) emit({ status: json.status })
      } catch { /* ignore */ }
    }
  }
  emit({ done: true })
}

export async function deleteModel(model: string): Promise<void> {
  const res = await fetch(OLLAMA_BASE + '/api/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model })
  })
  if (!res.ok) throw new Error(`删除失败 (${res.status})`)
}

/** 检查安装包是否已就绪（由外层下载好后放到该路径） */
export function findSetupFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null
  const f = fs.readdirSync(dir).find((x) => /^OllamaSetup.*\.exe$/i.test(x))
  return f ? path.join(dir, f) : null
}

/** 静默安装到指定目录（Inno Setup 参数），并配置 OLLAMA_MODELS */
export function installOllama(setupPath: string, installDir: string, modelsDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(installDir, { recursive: true })
    fs.mkdirSync(modelsDir, { recursive: true })
    // 用户级环境变量，Ollama 服务重启后读取
    spawn('setx', ['OLLAMA_MODELS', modelsDir], { windowsHide: true })
    const child = spawn(setupPath, [`/DIR=${installDir}`, '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], {
      windowsHide: true,
      cwd: path.dirname(setupPath)
    })
    child.on('close', (code) => {
      if (code === 0) resolve(installDir)
      else reject(new Error(`安装程序退出码 ${code}（可能被杀毒软件拦截，或需要手动运行 ${setupPath}）`))
    })
    child.on('error', (e) => reject(e))
  })
}

/** 本进程拉起（而非用户自己开的）的 ollama serve PID；退出时据此收尾 */
let lastOllamaPid: number | null = null

export function startedOllamaPid(): number | null {
  return lastOllamaPid
}

/** 尝试启动 ollama serve（找不到就用 PATH 里的 ollama）；始终显式注入 OLLAMA_MODELS，避免环境变量丢失。
 *  注意：不要走 `ollama app.exe` 托盘——它自己另起 serve 时不会带上我们注入的环境变量，
 *  结果 serve 回落到默认目录 C:\Users\<用户>\.ollama\models，/api/tags 直接变空（本机实测踩过）。
 *  必须直接 spawn `ollama.exe serve`，环境变量才一定生效。 */
export function startOllamaServe(installDir: string, modelsDir?: string): Promise<boolean> {
  const candidates = [path.join(installDir, 'ollama.exe'), 'ollama']
  const env = { ...process.env }
  if (modelsDir) env.OLLAMA_MODELS = modelsDir
  // 这两个不跟上，serve 起得来但模型上下文只有默认 4096，长对话直接崩（本机实测）
  if (!env.OLLAMA_CONTEXT_LENGTH) env.OLLAMA_CONTEXT_LENGTH = '32768'
  if (!env.OLLAMA_HOST) env.OLLAMA_HOST = '127.0.0.1:11434'
  return new Promise((resolve) => {
    const tryNext = (i: number): void => {
      if (i >= candidates.length) return resolve(false)
      try {
        const child = spawn(candidates[i], ['serve'], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
          env
        })
        child.unref()
        lastOllamaPid = child.pid ?? null
        child.on('error', () => tryNext(i + 1))
        // 轮询等就绪：固定 4 秒太短，冷启动时 serve 还没监听端口就被判失败（本机实测误报）
        void (async () => {
          for (let wait = 0; wait < 24; wait++) {
            await new Promise((r) => setTimeout(r, 1000))
            const st = await ollamaStatus()
            if (st.running) return resolve(true)
          }
          resolve(false)
        })()
      } catch {
        tryNext(i + 1)
      }
    }
    tryNext(0)
  })
}
