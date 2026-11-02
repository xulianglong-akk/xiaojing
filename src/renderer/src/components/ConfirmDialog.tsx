/** 统一确认弹窗（删除等不可逆操作） */
export default function ConfirmDialog({
  title,
  message,
  confirmText = '删除',
  onConfirm,
  onCancel
}: {
  title: string
  message: string
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="confirm-msg">{message}</p>
        <div className="row-end">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
