import { useEffect, useRef, useState } from 'react'
import { ProviderConfig } from '../api'
import { CONTEXT_PRESETS, fmtK } from '../ctx'

export type ReasoningLevel = 'off' | 'low' | 'high'

const LEVEL_LABEL: Record<ReasoningLevel, string> = {
  off: '无',
  low: '低',
  high: '高'
}

/**
 * 右下角模型弹层（DeepSeek 桌面端式）：
 * 收起时显示「模型名 等级 ˄」，点开向上弹出「模型 / 推理等级 / 上下文预算」三行，行内再展开选择。
 */
export default function ModelPopover({
  providers,
  providerId,
  model,
  level,
  contextTokens,
  onChange,
  onLevel,
  onContext
}: {
  providers: ProviderConfig[]
  providerId: string
  model: string
  level: ReasoningLevel
  contextTokens: number
  onChange: (providerId: string, model: string) => void
  onLevel: (l: ReasoningLevel) => void
  onContext: (n: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [expand, setExpand] = useState<'none' | 'model' | 'level' | 'context'>('none')
  const [openGroup, setOpenGroup] = useState<string | null>(null) // 展开的厂商分组（收束式，默认全部收起）
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setExpand('none')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const currentName = providers.find((p) => p.id === providerId)?.name ?? providerId
  const groups = providers.filter((p) => p.models.length > 0 || p.id === providerId)

  return (
    <div className="model-pop-wrap" ref={wrapRef}>
      <button
        type="button"
        className={'model-trigger' + (open ? ' open' : '')}
        onClick={() => {
          setOpen((v) => !v)
          setExpand('none')
        }}
        title="模型与推理等级"
      >
        {model || '选择模型'}
        <span className="model-trigger-level">{LEVEL_LABEL[level]}</span>
        <span className="model-trigger-arrow">{open ? '˅' : '˄'}</span>
      </button>

      {open && (
        <div className="model-pop">
          {/* 模型行 */}
          <button
            type="button"
            className="mp-row"
            onClick={() => {
              setExpand((x) => (x === 'model' ? 'none' : 'model'))
              setOpenGroup(null) // 每次展开列表都从全收起开始
            }}
          >
            <span className="mp-row-label">模型</span>
            <span className="mp-row-value">
              {model} <span className="mp-row-sub">{currentName}</span>
            </span>
            <span className="mp-row-arrow">{expand === 'model' ? '˅' : '›'}</span>
          </button>
          {expand === 'model' && (
            <div className="mp-list">
              {groups.length === 0 && (
                <div className="mp-empty">还没有可用模型，请先到设置里接入</div>
              )}
              {groups.map((p) => {
                const open = openGroup === p.id
                const isCur = p.id === providerId
                return (
                  <div key={p.id}>
                    <button
                      type="button"
                      className="mp-group-row"
                      title={open ? '收起该厂商的模型' : '展开该厂商的模型'}
                      onClick={() => setOpenGroup(open ? null : p.id)}
                    >
                      <span className="mp-group-caret">{open ? '▾' : '▸'}</span>
                      <span className="mp-group-name">{p.name}</span>
                      {isCur && !open && <span className="mp-row-sub">{model}</span>}
                      <span className="mp-group-count">{p.models.length}</span>
                    </button>
                    {open &&
                      p.models.map((m) => (
                        <button
                          key={p.id + m}
                          type="button"
                          className={'mp-opt' + (isCur && m === model ? ' sel' : '')}
                          onClick={() => {
                            onChange(p.id, m)
                            setOpen(false)
                            setExpand('none')
                          }}
                        >
                          {m}
                          {isCur && m === model && <span className="mp-check">✓</span>}
                        </button>
                      ))}
                  </div>
                )
              })}
            </div>
          )}

          {/* 推理等级行 */}
          <button
            type="button"
            className="mp-row"
            onClick={() => setExpand((x) => (x === 'level' ? 'none' : 'level'))}
          >
            <span className="mp-row-label">推理等级</span>
            <span className="mp-row-value">{LEVEL_LABEL[level]}</span>
            <span className="mp-row-arrow">{expand === 'level' ? '˅' : '›'}</span>
          </button>
          {expand === 'level' && (
            <div className="mp-list">
              {(['off', 'low', 'high'] as ReasoningLevel[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  className={'mp-opt' + (l === level ? ' sel' : '')}
                  onClick={() => {
                    onLevel(l)
                    setExpand('none')
                  }}
                >
                  {l === 'off' ? '无 · 快速回答' : l === 'low' ? '低 · 简单思考' : '高 · 深度思考'}
                  {l === level && <span className="mp-check">✓</span>}
                </button>
              ))}
            </div>
          )}

          {/* 上下文预算行 */}
          <button
            type="button"
            className="mp-row"
            onClick={() => setExpand((x) => (x === 'context' ? 'none' : 'context'))}
            title="上下文预算：超过 80% 自动把旧对话压缩成记忆"
          >
            <span className="mp-row-label">上下文</span>
            <span className="mp-row-value">{fmtK(contextTokens)}</span>
            <span className="mp-row-arrow">{expand === 'context' ? '˅' : '›'}</span>
          </button>
          {expand === 'context' && (
            <div className="mp-list">
              {CONTEXT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className={'mp-opt' + (p.value === contextTokens ? ' sel' : '')}
                  onClick={() => {
                    onContext(p.value)
                    setExpand('none')
                  }}
                >
                  {p.label}
                  {p.value === contextTokens && <span className="mp-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
