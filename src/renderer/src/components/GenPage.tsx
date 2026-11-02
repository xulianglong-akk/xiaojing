import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  AppSettings,
  GenSession,
  GenMsg,
  GenModelInfo,
  GenParams
} from '../api'
import { useSidebarWidth } from '../useSidebarWidth'
import ModeMenu, { Tab } from './ModeMenu'
import { Gear, Trash, ImageIcon, FilmIcon, MusicIcon } from './Icons'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  settings: AppSettings | null
  kind: 'image' | 'video' | 'audio'
  tab: Tab
  onTab: (t: Tab) => void
  onSettings: () => void
}

/** 单个会话的生成状态（并行会话各自独立） */
interface GenStream {
  status: string
  error?: string
}

const IMAGE_SIZES: { label: string; w: number; h: number }[] = [
  { label: '1:1', w: 1024, h: 1024 },
  { label: '3:4', w: 896, h: 1152 },
  { label: '4:3', w: 1152, h: 896 },
  { label: '9:16', w: 768, h: 1344 },
  { label: '16:9', w: 1344, h: 768 }
]

const LTX_SIZES: { label: string; w: number; h: number }[] = [
  { label: '16:9', w: 768, h: 432 },
  { label: '1:1', w: 640, h: 640 },
  { label: '9:16', w: 432, h: 768 }
]

const VIDEO_DURATIONS = [3, 4, 6, 8, 10]
const AUDIO_DURATIONS = [30, 60, 90, 120, 180]

const EXAMPLES_IMAGE = [
  '微缩移轴摄影：书桌上的一座雪山小镇，火车冒着棉花糖烟雾',
  '国风少女撑油纸伞站在竹林里，水墨画风格，雾气缭绕',
  '末日废墟的水泥缝里长出一朵发光的巨型蘑菇，一只白狐路过'
]

const EXAMPLES_VIDEO = [
  '一只柴犬戴着墨镜开敞篷车兜风，海滨公路夕阳逆光，表情很拽',
  '宇航员坐在月球上钓鱼，远处地球缓缓转动，安静电影感',
  '暴雨夜的霓虹便利店门口，一只橘猫甩着湿漉漉的毛，赛博朋克'
]

const EXAMPLES_AUDIO = [
  '国风电子, 古筝混搭合成器, 赛博长安夜市, 100 BPM',
  '8-bit 像素游戏 BGM, 欢快跳跃, 像勇者踏上了冒险开场',
  'Bossa nova, 慵懒午后, 海风咸味配冰美式, 轻快沙锤'
]

/** 切页会卸载重挂，按 kind 记住各自的作品，回来不至于"什么都没了" */
const cachedGenIds: Record<string, string | null> = {}

/** 生图 / 生视频页（类聊天 UI：左侧作品历史，主区提示词对话流） */
export default function GenPage({ settings, kind, tab, onTab, onSettings }: Props) {
  const side = useSidebarWidth('gen-' + kind, 260, 200, 400)
  const [sessions, setSessions] = useState<GenSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(cachedGenIds[kind] ?? null)
  useEffect(() => {
    cachedGenIds[kind] = activeId
  }, [activeId, kind])
  // 作品可能已被删：列表回来后校验
  useEffect(() => {
    if (activeId && sessions.length && !sessions.some((s) => s.id === activeId)) setActiveId(null)
  }, [sessions, activeId])
  const [messages, setMessages] = useState<GenMsg[]>([])
  const [streams, setStreams] = useState<Record<string, GenStream>>({})
  const [input, setInput] = useState('')
  const [models, setModels] = useState<GenModelInfo[]>([])
  const [modelId, setModelId] = useState<string>('')
  const [sizeIdx, setSizeIdx] = useState(0)
  const [duration, setDuration] = useState(kind === 'audio' ? 60 : 5)
  const [menuOpen, setMenuOpen] = useState<'model' | 'size' | 'dur' | null>(null)
  const [delTarget, setDelTarget] = useState<GenSession | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

  const kindModels = useMemo(() => models.filter((m) => m.kind === kind), [models, kind])
  const sizes = kind === 'video' ? LTX_SIZES : kind === 'audio' ? [] : IMAGE_SIZES

  const refreshModels = useCallback(() => {
    api.comfy.models().then(setModels).catch(() => {})
  }, [])

  const refreshSessions = useCallback(() => {
    api.gen.list(kind).then(setSessions)
  }, [kind])

  useEffect(() => {
    refreshModels()
    refreshSessions()
    const t = setInterval(refreshModels, 60000) // 下载中的模型会逐渐就绪
    return () => clearInterval(t)
  }, [refreshModels, refreshSessions])

  useEffect(() => {
    if (activeId) {
      api.gen.messages(activeId).then(setMessages)
    } else {
      setMessages([])
    }
  }, [activeId])

  // 打开页面时：恢复最近会话或停在新建态
  useEffect(() => {
    if (sessions.length > 0 && !activeId) setActiveId(sessions[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length])

  // 会话默认模型：优先会话记录 → 第一个就绪的 → 第一个
  useEffect(() => {
    const active = sessions.find((s) => s.id === activeId)
    const want = active?.modelId ?? ''
    if (want && kindModels.some((m) => m.id === want)) {
      if (modelId !== want) setModelId(want)
    } else if (!modelId || !kindModels.some((m) => m.id === modelId)) {
      const first = kindModels.find((m) => m.ready) ?? kindModels[0]
      if (first) setModelId(first.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindModels, activeId, sessions])

  // 模型切换时采纳其默认尺寸/时长
  useEffect(() => {
    const m = kindModels.find((x) => x.id === modelId)
    if (!m) return
    if (m.defaults.width && m.defaults.height) {
      const i = sizes.findIndex((s) => s.w === m.defaults!.width && s.h === m.defaults!.height)
      if (i >= 0) setSizeIdx(i)
    }
    if (m.defaults.duration) setDuration(m.defaults.duration)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, kindModels])

  const updStream = useCallback((sid: string, patch: Partial<GenStream>) => {
    setStreams((prev) => {
      const cur = prev[sid] ?? { status: '' }
      return { ...prev, [sid]: { ...cur, ...patch } }
    })
  }, [])

  // 切页回来恢复「生成中」（流状态随组件卸载丢了，任务其实还在跑）
  useEffect(() => {
    if (!activeId) return
    let alive = true
    api.gen
      .active()
      .then((ids: string[]) => {
        if (alive && ids.includes(activeId)) updStream(activeId, { status: '正在生成…' })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [activeId, updStream])

  const closeStream = useCallback((sid: string) => {
    setStreams((prev) => {
      if (!(sid in prev)) return prev
      const copy = { ...prev }
      delete copy[sid]
      return copy
    })
  }, [])

  useEffect(() => {
    const off = api.gen.onEvent((e: any) => {
      const sid: string = e.sessionId
      if (!sid) return
      switch (e.type) {
        case 'user-saved':
          if (sid === activeIdRef.current) setMessages((m) => [...m, e.message])
          break
        case 'status':
          updStream(sid, { status: e.text ?? '', error: undefined })
          break
        case 'done':
          if (sid === activeIdRef.current && e.message) setMessages((m) => [...m, e.message])
          refreshModels()
          break
        case 'session-title':
          refreshSessions()
          break
        case 'error':
          if (e.message !== '__aborted__') updStream(sid, { error: e.message })
          // 失败的 result 消息从磁盘刷新（带 error 字段）
          if (sid === activeIdRef.current) api.gen.messages(sid).then(setMessages)
          closeStream(sid)
          break
        case 'end':
          closeStream(sid)
          if (sid === activeIdRef.current) api.gen.messages(sid).then(setMessages)
          break
      }
    })
    return off
  }, [updStream, closeStream, refreshSessions, refreshModels])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streams])

  const submittingRef = useRef(false)
  const send = useCallback(
    async (override?: { prompt: string; params?: Partial<GenParams>; modelId?: string }) => {
      const prompt = (override?.prompt ?? input).trim()
      if (!prompt || !modelId) return
      // streams 是异步 state，连点会连建好几个新作品并重复提交 → 用 ref 同步闸门
      if (submittingRef.current) return
      submittingRef.current = true
      try {
        let sid = activeId
        if (!sid) {
          const s = await api.gen.create(kind, modelId)
          setSessions((prev) => [s, ...prev])
          setActiveId(s.id)
          sid = s.id
        }
        if (!sid) return
        if (streams[sid]) return // 该会话正在生成
        const m = kindModels.find((x) => x.id === (override?.modelId ?? modelId))
        const sz = sizes[sizeIdx]
        updStream(sid, { status: '正在排队…', error: undefined })
        if (!override) setInput('')
        api.gen.send({
          sessionId: sid,
          modelId: override?.modelId ?? modelId,
          prompt,
          width: override?.params?.width ?? sz?.w ?? 1024,
          height: override?.params?.height ?? sz?.h ?? 1024,
          duration: override?.params?.duration ?? duration
        })
      } finally {
        submittingRef.current = false
      }
    },
    [input, modelId, activeId, streams, kind, kindModels, sizes, sizeIdx, duration, updStream]
  )

  const active = sessions.find((s) => s.id === activeId) ?? null
  const st = activeId ? streams[activeId] : undefined
  const generating = !!st
  const currentModel = kindModels.find((m) => m.id === modelId)
  const examples = kind === 'video' ? EXAMPLES_VIDEO : kind === 'audio' ? EXAMPLES_AUDIO : EXAMPLES_IMAGE

  const setSessionModel = async (id: string) => {
    const updated = await api.gen.update(id, { modelId })
    setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }

  useEffect(() => {
    if (active && active.modelId !== modelId && modelId) setSessionModel(active.id).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, active?.id])

  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const renderItem = (s: GenSession) => (
    <div
      key={s.id}
      className={'session-item' + (s.id === activeId ? ' active' : '')}
      onClick={() => setActiveId(s.id)}
    >
      <span className="session-title">{s.title}</span>
      <button
        className="session-del"
        title="删除"
        onClick={(e) => {
          e.stopPropagation()
          setDelTarget(s)
        }}
      >
        <Trash />
      </button>
    </div>
  )

  const imgName = (n: string) => `xjfile://img/${encodeURIComponent(n)}`
  const vidName = (n: string) => `xjfile://video/${encodeURIComponent(n)}`
  const audName = (n: string) => `xjfile://audio/${encodeURIComponent(n)}`

  const resultBlock = (m: GenMsg) => {
    const mdl = models.find((x) => x.id === m.modelId)
    if (m.error) {
      return (
        <div className="msg assistant">
          <div className="error-box">⚠ {m.error}</div>
          <button className="btn ghost sm" onClick={() => send({ prompt: m.prompt, params: m.params, modelId: m.modelId })}>
            ↻ 重试
          </button>
        </div>
      )
    }
    if (!m.images?.length && !m.video && !m.audio) {
      return (
        <div className="msg assistant">
          <div className="status-line pulse">{st?.status || '正在生成…'}</div>
        </div>
      )
    }
    return (
      <div className="msg assistant">
        {kind === 'video' && m.video ? (
          <video className="gen-video" src={vidName(m.video)} controls preload="metadata" />
        ) : kind === 'audio' && m.audio ? (
          <audio className="gen-audio" src={audName(m.audio)} controls preload="metadata" />
        ) : (
          m.images && (
            <div className="msg-images">
              {m.images.map((n) => (
                <img key={n} src={imgName(n)} alt={m.prompt.slice(0, 30)} />
              ))}
            </div>
          )
        )}
        {m.meta && <div className="gen-meta">{m.meta}</div>}
        <div className="gen-actions">
          <button
            className="btn ghost sm"
            title="换个种子再生成"
            onClick={() => send({ prompt: m.prompt, params: m.params, modelId: m.modelId })}
          >
            ↻ 重新生成
          </button>
          {m.images?.map((n) => (
            <a key={'dl' + n} className="btn ghost sm" href={imgName(n)} download={n}>
              ↓ 保存
            </a>
          ))}
          {m.video && (
            <a className="btn ghost sm" href={vidName(m.video)} download={m.video}>
              ↓ 保存
            </a>
          )}
          {m.audio && (
            <a className="btn ghost sm" href={audName(m.audio)} download={m.audio}>
              ↓ 保存
            </a>
          )}
          <span className="dim gen-model-tag">{mdl?.name ?? m.modelId}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-layout">
      <aside className={'sidebar' + (side.dragging ? ' dragging' : '')} style={{ width: side.width }}>
        <div className="side-resizer" onMouseDown={side.onDown} />
        <div className="side-head">
          <ModeMenu tab={tab} onChange={onTab} />
          <button className="icon-btn" title="设置" onClick={onSettings}>
            <Gear />
          </button>
        </div>
        <button
          className="btn primary full"
          onClick={() => {
            setActiveId(null)
            setInput('')
          }}
        >
          ＋ 新作品
        </button>
        <div className="session-list">
          {sessions.map(renderItem)}
          {sessions.length === 0 && (
            <div className="side-divider">
              {kind === 'image' ? '还没有作品' : kind === 'audio' ? '还没有音乐' : '还没有视频'}
            </div>
          )}
        </div>
      </aside>

      <section className="chat-main">
        <div className="messages">
          {messages.length === 0 && !generating && (
            <div className="empty-hint">
              <div className="empty-logo gen-empty-icon">
                {kind === 'image' ? <ImageIcon size={40} /> : kind === 'audio' ? <MusicIcon size={40} /> : <FilmIcon size={40} />}
              </div>
              <p>
                {kind === 'image'
                  ? '描述你想的画面，本地模型直接生成'
                  : kind === 'audio'
                    ? '描述音乐风格与氛围，本地模型直接出歌'
                    : '描述动态画面，本地模型直接生成视频'}
              </p>
              <div className="gen-examples">
                {examples.map((p) => (
                  <button key={p} className="gen-example" onClick={() => setInput(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="msg user">
                <div>{m.prompt}</div>
                {m.params && (
                  <div className="gen-param-tags">
                    {m.modelId && models.find((x) => x.id === m.modelId)?.name}
                    {kind === 'audio' ? ` · ${m.params.duration}s` : ` · ${m.params.width}×${m.params.height}`}
                    {kind === 'video' ? ` · ${m.params.duration}s` : ''}
                  </div>
                )}
              </div>
            ) : (
              <div key={m.id}>{resultBlock(m)}</div>
            )
          )}
          {st?.status && !messages.some((m) => m.role === 'result' && !m.images && !m.video && !m.error) && (
            <div className="msg assistant">
              <div className="status-line pulse">{st.status}</div>
            </div>
          )}
          {st?.error && <div className="error-box">⚠ {st.error}</div>}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          <textarea
            value={input}
            placeholder={
              kind === 'image'
                ? '描述画面：主体 + 场景 + 风格 + 光线…（Enter 生成）'
                : kind === 'audio'
                  ? '描述音乐：风格 + BPM + 乐器 + 情绪氛围…（Enter 生成）'
                  : '描述动态：镜头怎么动 + 主体做什么 + 氛围…（Enter 生成）'
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={2}
          />
          <div className="composer-bottom" ref={menuOpen ? menuRef : undefined}>
            <div className="gen-pills">
              <button
                className={'chip' + (menuOpen === 'model' ? ' on' : '')}
                onClick={() => setMenuOpen(menuOpen === 'model' ? null : 'model')}
                title="选择生成模型"
              >
                <span className="gen-pill-icon">
                  {kind === 'image' ? <ImageIcon size={14} /> : kind === 'audio' ? <MusicIcon size={14} /> : <FilmIcon size={14} />}
                </span>
                {currentModel ? currentModel.name : '选择模型'}
                {!currentModel?.ready && '（下载中）'} ▾
              </button>
              {menuOpen === 'model' && (
                <div className="gen-model-pop">
                  {kindModels.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={'gen-model-item' + (m.id === modelId ? ' sel' : '')}
                      disabled={!m.ready}
                      title={m.ready ? m.desc : `文件不完整：缺 ${m.missing[0]}`}
                      onClick={() => {
                        setModelId(m.id)
                        setMenuOpen(null)
                      }}
                    >
                      <span className="gen-model-name">
                        {m.ready ? '' : '⏳ '}
                        {m.name}
                      </span>
                      <span className="gen-model-desc">{m.ready ? m.desc : `缺 ${m.missing.length} 个文件`}</span>
                    </button>
                  ))}
                </div>
              )}
              {sizes.length > 0 && (
                <button
                  className={'chip' + (menuOpen === 'size' ? ' on' : '')}
                  onClick={() => setMenuOpen(menuOpen === 'size' ? null : 'size')}
                  title="画面尺寸"
                >
                  {sizes[sizeIdx].label} {sizes[sizeIdx].w}×{sizes[sizeIdx].h} ▾
                </button>
              )}
              {menuOpen === 'size' && sizes.length > 0 && (
                <div className="gen-model-pop">
                  {sizes.map((s, i) => (
                    <button
                      key={s.label}
                      type="button"
                      className={'gen-model-item' + (i === sizeIdx ? ' sel' : '')}
                      onClick={() => {
                        setSizeIdx(i)
                        setMenuOpen(null)
                      }}
                    >
                      <span className="gen-model-name">
                        {s.label} · {s.w}×{s.h}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {kind !== 'image' && (
                <button
                  className={'chip' + (menuOpen === 'dur' ? ' on' : '')}
                  onClick={() => setMenuOpen(menuOpen === 'dur' ? null : 'dur')}
                  title="时长（秒）"
                >
                  ⏱ {duration}s ▾
                </button>
              )}
              {menuOpen === 'dur' && (
                <div className="gen-model-pop">
                  {(kind === 'audio' ? AUDIO_DURATIONS : VIDEO_DURATIONS).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={'gen-model-item' + (d === duration ? ' sel' : '')}
                      onClick={() => {
                        setDuration(d)
                        setMenuOpen(null)
                      }}
                    >
                      <span className="gen-model-name">{d} 秒</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
              {generating ? (
                <button
                  className="send-btn stop"
                  title="停止"
                  onClick={() => {
                    if (!activeId) return
                    api.gen.stop(activeId)
                    // 本地立即解锁：主进程若已崩（无 end 事件），不该卡死输入
                    closeStream(activeId)
                  }}
                >
                  ■
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={() => send()}
                  disabled={!input.trim() || !currentModel?.ready}
                  title={currentModel?.ready ? '生成' : '模型文件未就绪（正在下载）'}
                >
                  ↑
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {delTarget && (
        <ConfirmDialog
          title="删除作品"
          message={`删除「${delTarget.title}」？生成记录会一并删除，不可恢复。`}
          onCancel={() => setDelTarget(null)}
          onConfirm={async () => {
            // 正在生成的先停掉：否则 ComfyUI 那头继续跑，出图后会往已删除的记录里写，
            // 产物文件也会变成没人引用的孤儿
            if (streams[delTarget.id]) {
              api.gen.stop(delTarget.id)
              await new Promise((r) => setTimeout(r, 400))
            }
            await api.gen.delete(delTarget.id)
            const rest = sessions.filter((x) => x.id !== delTarget.id)
            setSessions(rest)
            if (activeId === delTarget.id) setActiveId(rest[0]?.id ?? null)
            setDelTarget(null)
          }}
        />
      )}
    </div>
  )
}
