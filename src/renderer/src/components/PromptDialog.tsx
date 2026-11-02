import { useEffect, useRef, useState } from 'react'

/**
 * 单行文本输入弹窗 —— Electron 里 window.prompt 不可用，所有"输入一段文字"的场景都用它。
 */
export default function PromptDialog({
  title,
  placeholder,
  okLabel = '确定',
  allowEmpty = false,
  onOk,
  onCancel
}: {
  title: string
  placeholder?: string
  okLabel?: string
  allowEmpty?: boolean // 允许空值确认（如「留空清除密钥」）
  onOk: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const ok = () => {
    if (!allowEmpty && !value.trim()) return
    onOk(allowEmpty ? value : value.trim())
  }

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <input
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ok()
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="row-end">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!allowEmpty && !value.trim()} onClick={ok}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
