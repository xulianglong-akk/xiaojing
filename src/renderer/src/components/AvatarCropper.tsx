import { useEffect, useRef, useState } from 'react'

const MASK = 260 // 框选区显示尺寸（正方形，圆形蒙版）
const OUT = 256 // 输出分辨率

/**
 * QQ 式头像框选：拖动图片调整位置，滚轮/滑杆缩放，圆形蒙版内即为头像。
 * 确认后通过 canvas 裁剪输出 PNG data URL。
 */
export default function AvatarCropper({
  src,
  onOk,
  onCancel
}: {
  src: string
  onOk: (dataUrl: string) => void
  onCancel: () => void
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [ready, setReady] = useState(false)
  const [dims, setDims] = useState({ w: 0, h: 0, base: 1 }) // cover 基准下的显示尺寸
  const [scale, setScale] = useState(1) // 相对 cover 的缩放倍数（1~5）
  const [off, setOff] = useState({ x: 0, y: 0 }) // 图片左上角相对框选区的位移
  const stateRef = useRef({ scale: 1, off: { x: 0, y: 0 } })
  stateRef.current = { scale, off }
  const drag = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null)

  const clampOff = (x: number, y: number, s: number) => {
    const w = dims.w * s
    const h = dims.h * s
    return { x: Math.min(0, Math.max(MASK - w, x)), y: Math.min(0, Math.max(MASK - h, y)) }
  }

  const onLoad = () => {
    const img = imgRef.current!
    const base = Math.max(MASK / img.naturalWidth, MASK / img.naturalHeight)
    const w = img.naturalWidth * base
    const h = img.naturalHeight * base
    setDims({ w, h, base })
    setScale(1)
    setOff({ x: (MASK - w) / 2, y: (MASK - h) / 2 })
    setReady(true)
  }

  const zoomTo = (target: number) => {
    const { scale: s0, off } = stateRef.current
    const s1 = Math.min(5, Math.max(1, target))
    if (s1 === s0) return
    // 以框选中心为锚点缩放
    const cx = MASK / 2 - off.x
    const cy = MASK / 2 - off.y
    setScale(s1)
    setOff(clampOff(MASK / 2 - cx * (s1 / s0), MASK / 2 - cy * (s1 / s0), s1))
  }

  const onDown = (e: React.MouseEvent) => {
    drag.current = { mx: e.clientX, my: e.clientY, ox: stateRef.current.off.x, oy: stateRef.current.off.y }
    const move = (ev: MouseEvent) => {
      if (!drag.current) return
      const { x, y } = clampOff(
        drag.current.ox + (ev.clientX - drag.current.mx),
        drag.current.oy + (ev.clientY - drag.current.my),
        stateRef.current.scale
      )
      setOff({ x, y })
    }
    const up = () => {
      drag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const doCrop = () => {
    const img = imgRef.current
    if (!img || !ready) return
    const { scale: s, off } = stateRef.current
    const k = dims.base * s
    const sx = -off.x / k
    const sy = -off.y / k
    const sw = MASK / k
    const canvas = document.createElement('canvas')
    canvas.width = OUT
    canvas.height = OUT
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, sx, sy, sw, sw, 0, 0, OUT, OUT)
    onOk(canvas.toDataURL('image/png'))
  }

  // 尺寸/缩放变化后重新约束位移
  useEffect(() => {
    if (ready) setOff((o) => clampOff(o.x, o.y, scale))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims, scale, ready])

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>框选头像</h3>
        <div className="crop-stage" onMouseDown={onDown} onWheel={(e) => { e.preventDefault(); zoomTo(stateRef.current.scale * (e.deltaY < 0 ? 1.1 : 0.9)) }}>
          <img
            ref={imgRef}
            src={src}
            onLoad={onLoad}
            draggable={false}
            alt=""
            style={{
              position: 'absolute',
              width: dims.w * scale || undefined,
              height: dims.h * scale || undefined,
              left: off.x,
              top: off.y,
              maxWidth: 'none',
              userSelect: 'none'
            }}
          />
          <div className="crop-mask" />
        </div>
        <div className="crop-zoom">
          <span>缩放</span>
          <input
            type="range"
            min={1}
            max={5}
            step={0.01}
            value={scale}
            onChange={(e) => zoomTo(Number(e.target.value))}
          />
        </div>
        <p className="dim" style={{ textAlign: 'center', fontSize: 12, margin: '2px 0 8px' }}>
          拖动图片调整位置 · 滚轮或滑杆缩放
        </p>
        <div className="row-end">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!ready} onClick={doCrop}>
            就这个
          </button>
        </div>
      </div>
    </div>
  )
}
