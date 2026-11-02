import { useEffect, useState } from 'react'

/**
 * 自绘标题栏：无边框窗口的拖拽区 + 窗口控制键。
 * 拖拽区双击默认触发最大化/还原（Chromium 原生行为）。
 */
export default function TitleBar() {
  const [maxed, setMaxed] = useState(false)
  const [spinning, setSpinning] = useState(false)

  useEffect(() => {
    const off = window.api.win.onState((m: boolean) => setMaxed(m))
    return off
  }, [])

  /** 原地刷新：只重载渲染层界面（主进程与窗口不动），卡顿时的软恢复 */
  const doRefresh = () => {
    if (spinning) return
    setSpinning(true)
    setTimeout(() => window.location.reload(), 450)
  }

  return (
    <div className="titlebar">
      <span className="titlebar-brand">小镜</span>
      <div className="titlebar-controls">
        <button
          className={'tb-btn' + (spinning ? ' spin' : '')}
          title="刷新"
          onClick={doRefresh}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M8.6 5A3.6 3.6 0 1 1 7 2.1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
            <path
              d="M7.2 0.6v1.8H9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className="tb-btn" title="最小化" onClick={() => window.api.win.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="tb-btn"
          title={maxed ? '向下还原' : '最大化'}
          onClick={() => window.api.win.toggleMaximize()}
        >
          {maxed ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M2.5 2.5V.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x=".5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button className="tb-btn tb-close" title="关闭" onClick={() => window.api.win.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  )
}
