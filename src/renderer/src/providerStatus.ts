/**
 * 供应商连接状态（内存缓存）：
 * - 应用启动时对已接入 Key 的供应商自动全量检测一次（App.tsx）
 * - 接入新供应商 / 修改密钥 / 手动「测试」时即时检测
 * - ok === false（确认连不上）的供应商不会出现在模型选择器与默认模型下拉里
 */
import { useEffect, useState } from 'react'
import { api } from './api'

export interface ProvStatus {
  ok: boolean
  err?: string
  at: number
  testing?: boolean
}

const map = new Map<string, ProvStatus>()
const listeners = new Set<() => void>()

function put(id: string, st: ProvStatus) {
  map.set(id, st)
  listeners.forEach((l) => l())
}

export function getStatus(id: string): ProvStatus | undefined {
  return map.get(id)
}

/** 缓存是否仍新鲜（避免重复检测风暴） */
export function isFresh(id: string, maxAgeMs = 5 * 60 * 1000): boolean {
  const st = map.get(id)
  return !!st && !st.testing && Date.now() - st.at < maxAgeMs
}

/** 连接测试 = 用该供应商的 Key 请求一次 /models */
export async function testProvider(id: string): Promise<ProvStatus> {
  put(id, { ok: false, at: Date.now(), testing: true })
  try {
    const list = await api.models.list(id)
    const st: ProvStatus = {
      ok: list.length > 0,
      err: list.length ? undefined : '接口连通但未返回模型',
      at: Date.now()
    }
    put(id, st)
    return st
  } catch (e) {
    const st: ProvStatus = {
      ok: false,
      err: e instanceof Error ? e.message : String(e),
      at: Date.now()
    }
    put(id, st)
    return st
  }
}

/** 已拿到结论时的直接标记（如拉取模型成功/失败） */
export function markStatus(id: string, ok: boolean, err?: string): void {
  put(id, { ok, err, at: Date.now() })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useProvStatus(): Record<string, ProvStatus> {
  const [snap, setSnap] = useState<Record<string, ProvStatus>>(() => Object.fromEntries(map))
  useEffect(() => subscribe(() => setSnap(Object.fromEntries(map))), [])
  return snap
}
