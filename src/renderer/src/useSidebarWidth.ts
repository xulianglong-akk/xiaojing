import { useCallback, useRef, useState } from 'react'

/**
 * 侧栏拖拽调宽：按住右缘把手左右拖动，宽度限制在 [min, max]，记忆到 localStorage。
 */
export function useSidebarWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('xj-side-' + key))
      if (v >= min && v <= max) return v
    } catch { /* ignore */ }
    return initial
  })
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ x: 0, w: 0 })

  const onDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startRef.current = { x: e.clientX, w: width }
      setDragging(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const onMove = (ev: MouseEvent): void => {
        const w = Math.min(max, Math.max(min, startRef.current.w + (ev.clientX - startRef.current.x)))
        setWidth(w)
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setDragging(false)
        setWidth((w) => {
          try {
            localStorage.setItem('xj-side-' + key, String(w))
          } catch { /* ignore */ }
          return w
        })
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [width, key, min, max]
  )

  return { width, dragging, onDown }
}
