/**
 * 文件夹通用 CRUD —— 聊天会话与 Codex 任务共用，按存储文件区分。
 */
import { readJSON, writeJSON } from './store'

export interface Folder {
  id: string
  name: string
  createdAt: number
}

export function listFoldersIn(file: string): Folder[] {
  return readJSON<Folder[]>(file, [])
}

export function createFolderIn(file: string, name: string): Folder {
  const f: Folder = {
    id: 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: name.trim() || '新文件夹',
    createdAt: Date.now()
  }
  writeJSON(file, [...listFoldersIn(file), f])
  return f
}

export function renameFolderIn(file: string, id: string, name: string): Folder {
  const list = listFoldersIn(file)
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) throw new Error('文件夹不存在')
  list[i] = { ...list[i], name: name.trim() || list[i].name }
  writeJSON(file, list)
  return list[i]
}

/** 仅移除文件夹本身；其中成员移回未分类由调用方处理 */
export function removeFolderIn(file: string, id: string): void {
  writeJSON(
    file,
    listFoldersIn(file).filter((x) => x.id !== id)
  )
}
