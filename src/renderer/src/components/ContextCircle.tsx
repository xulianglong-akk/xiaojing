import { fmtK } from '../ctx'

/**
 * 上下文用量：一条极细的进度条（平时不抢视线），鼠标移上去才展开百分比与明细。
 * 原来是 22px 的环形数字，视觉上太重、又总在发光；改成"贴着底边的细线"更符合极简风。
 */
export default function ContextCircle({ used, budget }: { used: number; budget: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(budget, 1)) * 100))
  const color = pct >= 90 ? '#ef4146' : pct >= 70 ? '#e6a23c' : '#10a37f'
  return (
    <span
      className="ctx-bar"
      title={`上下文窗口：${pct}% 已用\n已用 ${fmtK(used)} 标记，共 ${fmtK(budget)}`}
    >
      <span className="ctx-bar-track">
        {/* 即便 0% 也留一点点，否则看起来像"没有进度条" */}
        <span className="ctx-bar-fill" style={{ width: `${Math.max(pct, 3)}%`, background: color }} />
      </span>
      <span className="ctx-bar-pct">{pct}%</span>
    </span>
  )
}
