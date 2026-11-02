/**
 * 数据总览统计 —— 「数据」设置页的分类可视化。
 * 全部只读：扫描数据目录下的 JSON 与头像文件，不写入任何内容。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from './store'

export interface CategoryStat {
  key: string
  label: string
  size: number // 字节
  files: number
  detail: string
}

export interface DataStats {
  totalSize: number
  categories: CategoryStat[]
  activity: number[] // 最近 35 天每日消息数，索引 0 最旧
  facts: number // 记忆事实总数（会话+伙伴+群+全局偏好）
  updatedAt: number
}

function walk(dir: string): { files: number; size: number } {
  if (!fs.existsSync(dir)) return { files: 0, size: 0 }
  let files = 0
  let size = 0
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name)
    if (item.isDirectory()) {
      const r = walk(p)
      files += r.files
      size += r.size
    } else {
      files++
      try {
        size += fs.statSync(p).size
      } catch {
        /* 忽略 */
      }
    }
  }
  return { files, size }
}

function readJSON(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

function jsonFiles(dir: string, skip: (name: string) => boolean = () => false): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !skip(f))
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dataStats(): DataStats {
  const root = getDataDir()
  const categories: CategoryStat[] = []
  let facts = 0
  let totalSize = 0

  // 最近 35 天活动日历
  const today = new Date()
  const dayKeys: string[] = []
  for (let i = 34; i >= 0; i--) dayKeys.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)))
  const daySet = new Set(dayKeys)
  const activityMap = new Map<string, number>()
  const bump = (item: any) => {
    if (item && typeof item.ts === 'number') {
      const k = dayKey(new Date(item.ts))
      if (daySet.has(k)) activityMap.set(k, (activityMap.get(k) ?? 0) + 1)
    }
  }
  // 遍历消息数组并计数，返回总条数
  const countMessages = (dir: string): number => {
    let msgs = 0
    for (const f of jsonFiles(dir, (n) => n === 'sessions.json' || n === 'groups.json')) {
      const arr = readJSON(path.join(dir, f))
      if (Array.isArray(arr)) {
        msgs += arr.length
        arr.forEach(bump)
      }
    }
    return msgs
  }
  // 计算记忆事实总数（{ facts: string[] } 结构的文件）
  const countFacts = (dir: string): number => {
    let n = 0
    for (const f of jsonFiles(dir)) {
      const j = readJSON(path.join(dir, f))
      if (j && Array.isArray(j.facts)) n += j.facts.length
    }
    return n
  }

  // 1. 聊天会话
  {
    const dir = path.join(root, 'chat')
    const st = walk(dir)
    const sessions = (readJSON(path.join(dir, 'sessions.json')) as any[] | null)?.length ?? 0
    const msgs = countMessages(dir)
    categories.push({ key: 'chat', label: '聊天会话', size: st.size, files: st.files, detail: `${sessions} 个会话 · ${msgs} 条消息` })
    totalSize += st.size
  }

  // 2. 会话记忆
  {
    const dir = path.join(root, 'chat-memory')
    const st = walk(dir)
    const n = countFacts(dir)
    facts += n
    categories.push({ key: 'chat-memory', label: '会话记忆', size: st.size, files: st.files, detail: `${st.files} 份 · ${n} 条关键事实` })
    totalSize += st.size
  }

  // 3. 机器人
  {
    const dir = path.join(root, 'bots')
    const st = walk(dir)
    const bots = (readJSON(path.join(dir, 'bots.json')) as any[] | null)?.length ?? 0
    categories.push({ key: 'bots', label: '机器人', size: st.size, files: st.files, detail: `${bots} 个伙伴` })
    totalSize += st.size
  }

  // 4. 伙伴对话（含伙伴记忆）
  {
    const dir = path.join(root, 'bot-chats')
    const st = walk(dir)
    const msgs = countMessages(dir)
    const n = countFacts(dir)
    facts += n
    categories.push({ key: 'bot-chats', label: '伙伴对话', size: st.size, files: st.files, detail: `${msgs} 条消息 · ${n} 条记忆` })
    totalSize += st.size
  }

  // 5. 群聊（含群记忆）
  {
    const dir = path.join(root, 'group-chats')
    const st = walk(dir)
    const groups = (readJSON(path.join(root, 'groups', 'groups.json')) as any[] | null)?.length ?? 0
    const msgs = countMessages(dir)
    const n = countFacts(dir)
    facts += n
    categories.push({ key: 'group-chats', label: '群聊', size: st.size, files: st.files, detail: `${groups} 个群 · ${msgs} 条消息` })
    totalSize += st.size
  }

  // 6. Codex 任务
  {
    const dir = path.join(root, 'codex')
    const st = walk(dir)
    const sessions = (readJSON(path.join(dir, 'sessions.json')) as any[] | null) ?? []
    const records = sessions.reduce((n, s) => n + (Array.isArray(s.history) ? s.history.length : 0), 0)
    categories.push({ key: 'codex', label: 'Codex 任务', size: st.size, files: st.files, detail: `${sessions.length} 个任务 · ${records} 条执行记录` })
    totalSize += st.size
  }

  // 7. 头像图片
  {
    const dir = path.join(root, 'avatars')
    const st = walk(dir)
    categories.push({ key: 'avatars', label: '头像图片', size: st.size, files: st.files, detail: `${st.files} 张` })
    totalSize += st.size
  }

  // 8. 全局偏好 + 配置
  {
    const gm = readJSON(path.join(root, 'global-memory.json'))
    const prefs = gm && Array.isArray(gm.preferences) ? gm.preferences.length : 0
    facts += prefs
    const s1 = fs.existsSync(path.join(root, 'global-memory.json'))
      ? fs.statSync(path.join(root, 'global-memory.json')).size
      : 0
    const s2 = fs.existsSync(path.join(root, 'settings.json')) ? fs.statSync(path.join(root, 'settings.json')).size : 0
    categories.push({ key: 'global', label: '偏好与配置', size: s1 + s2, files: s1 ? 2 : 1, detail: `${prefs} 条全局偏好` })
    totalSize += s1 + s2
  }

  return {
    totalSize,
    categories,
    activity: dayKeys.map((k) => activityMap.get(k) ?? 0),
    facts,
    updatedAt: Date.now()
  }
}
