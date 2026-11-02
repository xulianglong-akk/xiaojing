import { useEffect, useRef, useState } from 'react'

export type Tab = 'chat' | 'codex' | 'image' | 'video' | 'music' | 'bots'

const LABEL: Record<Tab, string> = {
  chat: '聊天',
  codex: 'Codex',
  image: '生图',
  video: '生视频',
  music: '生音乐',
  bots: '机器人'
}

/** 侧栏顶部的模式下拉（ChatGPT 式：应用名/模式 ▾ 收在侧栏里） */
export default function ModeMenu({
  tab,
  onChange
}: {
  tab: Tab
  onChange: (t: Tab) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="mode-dd" ref={ref}>
      <button
        className={'mode-btn' + (open ? ' open' : '')}
        onClick={() => setOpen((v) => !v)}
        title="切换模式"
      >
        {LABEL[tab]}
        <span className="mode-arr">▾</span>
      </button>
      {open && (
        <div className="mode-menu">
          {(Object.keys(LABEL) as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              className={'mode-opt' + (tab === t ? ' sel' : '')}
              onClick={() => {
                onChange(t)
                setOpen(false)
              }}
            >
              {LABEL[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
