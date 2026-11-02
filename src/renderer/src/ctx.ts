/** 上下文用量估算（与主进程 memory.ts 同一套口径）：中文 1 字 1 token，英文约 4 字符 1 token */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x2e80) cjk++
  }
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/** 16384 → 16K */
export function fmtK(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10}M`
  if (n >= 1024) return `${Math.round(n / 1024)}K`
  return String(n)
}

export const CONTEXT_PRESETS: { label: string; value: number }[] = [
  { label: '16K · 轻量', value: 16384 },
  { label: '32K · 标准', value: 32768 },
  { label: '64K · 加大', value: 65536 },
  { label: '128K · 长对话', value: 131072 },
  { label: '256K · 超长', value: 262144 },
  { label: '512K · 巨量', value: 524288 },
  { label: '1M · 极限', value: 1048576 }
]
