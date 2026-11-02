import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  AppSettings,
  ChatSession,
  ChatFolder,
  ChatMsg,
  LLMTarget,
  SearchResult
} from '../api'
import { useSidebarWidth } from '../useSidebarWidth'
import ModelPopover, { ReasoningLevel } from './ModelPopover'
import ModeMenu, { Tab } from './ModeMenu'
import { Gear, Trash } from './Icons'
import ConfirmDialog from './ConfirmDialog'
import PromptDialog from './PromptDialog'
import { useProvStatus } from '../providerStatus'
import ContextCircle from './ContextCircle'
import { estimateTokens } from '../ctx'

interface Props {
  settings: AppSettings | null
  tab: Tab
  onTab: (t: Tab) => void
  onSettings: () => void
}

/** 单个会话的流式回复状态（并行会话各自独立） */
interface StreamState {
  text: string
  reasoning: string
  status: string
  sources: SearchResult[]
  images?: string[]
  video?: string
  audio?: string
  error?: string
}

/**
 * 切到别的页面（生图/机器人/Codex）时这个组件会被卸载，
 * 回来时如果一切从 useState(null) 重来，用户刚聊的会话就"没了"（其实在磁盘上）。
 * 用模块级变量记住当前会话，进程内切页保持；重启应用仍从干净状态开始。
 */
let cachedActiveChatId: string | null = null

export default function Chat({ settings, tab, onTab, onSettings }: Props) {
  const side = useSidebarWidth('chat', 260, 200, 400)
  const provStatus = useProvStatus()
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(cachedActiveChatId)
  useEffect(() => {
    cachedActiveChatId = activeId
  }, [activeId])
  // 缓存的会话可能已经被删掉：列表加载回来后校验一次，别停在空壳上
  useEffect(() => {
    if (activeId && sessions.length && !sessions.some((s) => s.id === activeId)) setActiveId(null)
  }, [sessions, activeId])
  const [messages, setMessages] = useState<ChatMsg[]>([])
  // 每个会话独立的流式状态（并行发消息互不串台）
  const [streams, setStreams] = useState<Record<string, StreamState>>({})
  const [input, setInput] = useState('')
  const [attach, setAttach] = useState<string[]>([]) // 待发送的图片（文件名，存数据目录 images/）
  const [webSearchOn, setWebSearchOn] = useState(false)
  const [showReasoning, setShowReasoning] = useState<Record<string, boolean>>({})
  const [delTarget, setDelTarget] = useState<ChatSession | null>(null)
  const [folders, setFolders] = useState<ChatFolder[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; kind: 'session' | 'folder'; id: string } | null>(null)
  const [renaming, setRenaming] = useState<{ kind: 'session' | 'folder'; id: string } | null>(null)
  const [renameText, setRenameText] = useState('')
  const [delFolder, setDelFolder] = useState<ChatFolder | null>(null)
  const [ctxMem, setCtxMem] = useState<{ compressedUpTo: number; facts: string[] } | null>(null)
  const [prefs, setPrefs] = useState<string[]>([])
  const [draft, setDraft] = useState<{ target?: LLMTarget; level?: ReasoningLevel }>({})
  const [draftCtx, setDraftCtx] = useState<number>(0) // 新状态页选择的上下文预算（0 = 未选）
  const [folderPrompt, setFolderPrompt] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

  useEffect(() => {
    api.memory.global().then((g) => setPrefs(g.preferences ?? []))
  }, [])

  useEffect(() => {
    api.chat.listSessions().then((s) => setSessions(s))
    api.chat.listFolders().then(setFolders)
  }, [])

  useEffect(() => {
    if (activeId) {
      api.chat.getMessages(activeId).then(setMessages)
      api.memory.session(activeId).then((m) => setCtxMem(m ?? null))
    } else {
      setMessages([])
      setCtxMem(null)
    }
  }, [activeId])

  // 稳定的流状态更新器（函数式，避免闭包过期）
  const sendingRef = useRef<Set<string>>(new Set())
  const updStream = useCallback((sid: string, patch: Partial<StreamState> | ((s: StreamState) => Partial<StreamState>)) => {
    setStreams((prev) => {
      const cur = prev[sid] ?? { text: '', reasoning: '', status: '', sources: [] }
      const p = typeof patch === 'function' ? patch(cur) : patch
      return { ...prev, [sid]: { ...cur, ...p } }
    })
  }, [])

  // 切页回来时流状态随组件卸载丢失了，但主进程可能还在回；问一下把「生成中」补回来，
  // 否则用户会以为没在跑，再点一次发送
  useEffect(() => {
    if (!activeId) return
    let alive = true
    api.chat
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
    const off = api.chat.onEvent((e: any) => {
      const sid: string = e.sessionId
      if (!sid) return
      switch (e.type) {
        case 'user-saved':
          // 只把当前正在看的会话的用户新消息追加到视图；其他会话已落盘，切换时从磁盘加载
          if (sid === activeIdRef.current) setMessages((m) => [...m, e.message])
          break
        case 'status':
          updStream(sid, { status: e.text })
          break
        case 'sources':
          updStream(sid, { sources: e.sources ?? [] })
          break
        case 'images':
          // 联合-生图 / 本地生成：工具生成的图片实时挂到流式消息上
          updStream(sid, (st) => ({ images: [...(st.images ?? []), ...((e.images as string[]) ?? [])] }))
          break
        case 'video':
          updStream(sid, { video: e.video })
          break
        case 'audio':
          updStream(sid, { audio: e.audio })
          break
        case 'delta':
          updStream(sid, (s) => ({ text: s.text + e.text }))
          break
        case 'reasoning':
          updStream(sid, (s) => ({ reasoning: s.reasoning + e.text }))
          break
        case 'done': {
          const st = streamsRef.current[sid]
          if (sid === activeIdRef.current) {
            setMessages((m) => [
              ...m,
              {
                id: e.id,
                role: 'assistant',
                content: st?.text ?? '',
                reasoning: st?.reasoning || undefined,
                sources: st?.sources?.length ? st.sources : undefined,
                images: st?.images?.length ? st.images : undefined,
                video: st?.video,
                audio: st?.audio,
                aborted: e.aborted || undefined,
                ts: Date.now()
              }
            ])
          }
          closeStream(sid)
          break
        }
        case 'session-title':
          api.chat.listSessions().then(setSessions)
          break
        case 'error':
          // 以前是 updStream({error}) 之后马上 closeStream：下次 setState 就把整条流状态删了，
          // 错误信息永远显示不出来（服务没起来时用户只看到自己发的话、没有回复也没有提示）。
          // 改成把错误当成一条临时消息放进对话流，位置对、也不会被 closeStream 抹掉。
          if (e.message !== '__aborted__' && sid === activeIdRef.current) {
            setMessages((m) => [
              ...m,
              { id: 'err' + Date.now(), role: 'assistant', content: '', error: e.message, ts: Date.now() }
            ])
          }
          closeStream(sid)
          break
        case 'end':
          sendingRef.current.delete(sid)
          closeStream(sid)
          // 压缩可能刚发生，刷新当前会话的记忆状态供上下文圆圈使用
          if (sid === activeIdRef.current) api.memory.session(sid).then((m) => setCtxMem(m ?? null))
          break
      }
    })
    return off
  }, [updStream, closeStream])

  const streamsRef = useRef<Record<string, StreamState>>({})
  streamsRef.current = streams

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streams])

  const newSession = useCallback(() => {
    // ChatGPT 式：只切到全新状态，不立即创建会话；首条消息发送时才创建
    setActiveId(null)
  }, [])

  // 新状态页的未发送草稿：切走时暂存，再点「＋ 新会话」时恢复
  const newChatDraftRef = useRef('')
  const prevActiveIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevActiveIdRef.current === null && activeId !== null) {
      newChatDraftRef.current = input // 离开新状态：暂存没发出去的文字
      if (input) setInput('')
    } else if (activeId === null && prevActiveIdRef.current !== null) {
      setInput(newChatDraftRef.current) // 回到新状态：恢复草稿
    }
    prevActiveIdRef.current = activeId
  }, [activeId])

  // 选图 / 粘贴图片 → 落盘到数据目录 images/，输入区显示缩略图，发送时带上文件名
  const addImageFromDataUrl = useCallback(async (dataUrl: string) => {
    try {
      const name = await api.images.saveData(dataUrl)
      setAttach((a) => [...a, name].slice(0, 4))
    } catch (e) {
      alert('图片保存失败：' + String(e instanceof Error ? e.message : e))
    }
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    const files = attach
    if (!text && !files.length) return
    // 没有活动会话时（打开应用后的新状态）：发首条消息即自动创建会话，应用草稿里的模型/等级/上下文
    let sid = activeId
    if (!sid) {
      const fallback: LLMTarget = settings
        ? { providerId: settings.defaultProviderId, model: settings.defaultModel }
        : { providerId: 'ollama', model: 'llama3' }
      const s = await api.chat.createSession(draft.target ?? fallback)
      if (draft.level || draftCtx) {
        await api.chat.updateSession(s.id, {
          ...(draft.level ? { reasoningLevel: draft.level } : {}),
          ...(draftCtx ? { contextTokens: draftCtx } : {})
        })
      }
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      setDraft({})
      setDraftCtx(0)
      sid = s.id
    }
    if (!sid) return
    // streams[sid] 是异步 state：同一帧内连点几次它都还是空的，会连发好几条重复消息。
    // 再用一个 ref 做同步闸门兜住（实测三连点会发出 4 条）。
    if (streams[sid] || sendingRef.current.has(sid)) return
    sendingRef.current.add(sid)
    updStream(sid, { text: '', reasoning: '', status: '', sources: [], images: [], error: undefined })
    setInput('')
    setAttach([])
    api.chat.send({ sessionId: sid, userText: text, webSearch: webSearchOn, images: files.length ? files : undefined })
  }, [input, attach, streams, activeId, webSearchOn, settings, draft, draftCtx, updStream])

  const stop = useCallback(() => {
    if (activeId) api.chat.stop(activeId)
  }, [activeId])

  const active = sessions.find((s) => s.id === activeId) ?? null
  const st = activeId ? streams[activeId] : undefined
  const streaming = !!st

  // ---------- 会话列表：文件夹 / 归档 / 右键菜单 ----------

  const live = sessions.filter((s) => !s.archived)
  const archivedList = sessions.filter((s) => s.archived)
  const pinnedList = live.filter((s) => s.pinned)
  const hasFolder = (id?: string | null) => !!id && folders.some((f) => f.id === id)
  const unfiled = live.filter((s) => !s.pinned && !hasFolder(s.folderId))
  const inFolder = (fid: string) => live.filter((s) => !s.pinned && s.folderId === fid)
  const toggleSection = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))

  const patchSession = useCallback(async (id: string, patch: Partial<ChatSession>) => {
    const updated = await api.chat.updateSession(id, patch)
    setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }, [])

  const startRename = (kind: 'session' | 'folder', id: string) => {
    const cur =
      kind === 'session'
        ? sessions.find((s) => s.id === id)?.title
        : folders.find((f) => f.id === id)?.name
    setRenaming({ kind, id })
    setRenameText(cur ?? '')
  }

  const commitRename = useCallback(async () => {
    if (!renaming) return
    const name = renameText.trim()
    if (name) {
      if (renaming.kind === 'session') {
        await patchSession(renaming.id, { title: name })
      } else {
        const f = await api.chat.renameFolder(renaming.id, name)
        setFolders((prev) => prev.map((x) => (x.id === f.id ? f : x)))
      }
    }
    setRenaming(null)
  }, [renaming, renameText, patchSession])

  const createFolder = useCallback(async (name: string) => {
    if (!name.trim()) return
    const f = await api.chat.createFolder(name.trim())
    setFolders((prev) => [...prev, f])
  }, [])

  const removeFolder = useCallback(async (id: string) => {
    await api.chat.deleteFolder(id)
    setFolders((prev) => prev.filter((f) => f.id !== id))
    setSessions((prev) => prev.map((s) => (s.folderId === id ? { ...s, folderId: undefined } : s)))
  }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const renderItem = (s: ChatSession) => (
    <div
      key={s.id}
      className={'session-item' + (s.id === activeId ? ' active' : '')}
      onClick={() => setActiveId(s.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'session', id: s.id })
      }}
    >
      {renaming?.kind === 'session' && renaming.id === s.id ? (
        <input
          className="rename-input"
          value={renameText}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setRenameText(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') {
              setRenameText('')
              setRenaming(null)
            }
          }}
          onBlur={commitRename}
        />
      ) : (
        <>
          <span className="session-title">{s.title}</span>
          <button
            className="session-del"
            title="删除会话"
            onClick={(e) => {
              e.stopPropagation()
              setDelTarget(s)
            }}
          >
            <Trash />
          </button>
        </>
      )}
    </div>
  )

  const changeModel = useCallback(
    async (providerId: string, model: string) => {
      if (!active) {
        // 还没有会话（新状态页）：记为草稿，首条消息创建会话时生效
        setDraft((d) => ({ ...d, target: { providerId, model } }))
        return
      }
      const updated = await api.chat.updateSession(active.id, { target: { providerId, model } })
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    },
    [active]
  )

  const changeLevel = useCallback(
    async (level: ReasoningLevel) => {
      if (!active) {
        setDraft((d) => ({ ...d, level }))
        return
      }
      const updated = await api.chat.updateSession(active.id, { reasoningLevel: level })
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    },
    [active]
  )

  const changeContext = useCallback(
    async (n: number) => {
      setDraftCtx(n)
      if (!active) return
      const updated = await api.chat.updateSession(active.id, { contextTokens: n })
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    },
    [active]
  )

  // 上下文用量 = 记忆前缀（全局偏好 + 会话事实）+ 未压缩消息
  const contextBudget = active?.contextTokens ?? (draftCtx || settings?.chatTokens || settings?.memoryTokens) ?? 32768
  const usedTokens = useMemo(() => {
    const from = Math.min(ctxMem?.compressedUpTo ?? 0, messages.length)
    const msgsPart = messages.slice(from).map((m) => m.content).join('')
    return estimateTokens((prefs ?? []).join('') + (ctxMem?.facts ?? []).join('') + msgsPart)
  }, [messages, ctxMem, prefs])

  return (
    <div className="chat-layout">
      <aside
        className={'sidebar' + (side.dragging ? ' dragging' : '')}
        style={{ width: side.width }}
      >
        <div className="side-resizer" onMouseDown={side.onDown} />
        <div className="side-head">
          <ModeMenu tab={tab} onChange={onTab} />
          <button className="icon-btn" title="设置" onClick={onSettings}>
              <Gear />
            </button>
        </div>
        <button className="btn primary full" onClick={newSession}>
          ＋ 新会话
        </button>
        <div className="session-list">
          {pinnedList.length > 0 && (
            <div className="folder-group">
              <div
                className={'folder-head' + (collapsed['📌'] ? ' closed' : '')}
                onClick={() => toggleSection('📌')}
              >
                <span className="folder-caret">▾</span>
                <span className="folder-name">📌 置顶</span>
                <span className="folder-count">{pinnedList.length}</span>
              </div>
              {!collapsed['📌'] && pinnedList.map(renderItem)}
            </div>
          )}
          {folders.map((f) => {
            const items = inFolder(f.id)
            return (
              <div key={f.id} className="folder-group">
                <div
                  className={'folder-head' + (collapsed[f.id] ? ' closed' : '')}
                  onClick={() => toggleSection(f.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'folder', id: f.id })
                  }}
                >
                  {renaming?.kind === 'folder' && renaming.id === f.id ? (
                    <input
                      className="rename-input"
                      value={renameText}
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setRenameText(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        else if (e.key === 'Escape') {
                          setRenameText('')
                          setRenaming(null)
                        }
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <>
                      <span className="folder-caret">▾</span>
                      <span className="folder-name">{f.name}</span>
                      <span className="folder-count">{items.length}</span>
                    </>
                  )}
                </div>
                {!collapsed[f.id] && items.map(renderItem)}
              </div>
            )
          })}
          {unfiled.length > 0 && <div className="side-divider">最近</div>}
          {unfiled.map(renderItem)}
          {archivedList.length > 0 && (
            <>
              <div
                className={'side-divider archive-toggle' + (showArchived ? ' open' : '')}
                onClick={() => setShowArchived((v) => !v)}
              >
                <span className="folder-caret">▸</span> 已归档（{archivedList.length}）
              </div>
              {showArchived && archivedList.map(renderItem)}
            </>
          )}
        </div>
      </aside>

      <section className="chat-main">
        <div className="messages">
          {messages.length === 0 && !streaming && (
            <div className="empty-hint">
              <div className="empty-logo">小镜</div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={'msg ' + m.role}>
              {m.role === 'assistant' && m.reasoning && (
                <div className="reasoning-box">
                  <button
                    className="reasoning-toggle"
                    onClick={() =>
                      setShowReasoning((v) => ({ ...v, [m.id]: !v[m.id] }))
                    }
                  >
                    💭 思考过程 {showReasoning[m.id] ? '▾' : '▸'}
                  </button>
                  {showReasoning[m.id] && (
                    <div className="reasoning-content">{m.reasoning}</div>
                  )}
                </div>
              )}
              {m.images && m.images.length > 0 && (
                <div className="msg-images">
                  {m.images.map((n) => (
                    <img key={n} src={`xjfile://img/${encodeURIComponent(n)}`} alt={n} />
                  ))}
                </div>
              )}
              {m.video && (
                <video className="gen-video" src={`xjfile://video/${encodeURIComponent(m.video)}`} controls preload="metadata" />
              )}
              {m.audio && (
                <audio className="gen-audio" src={`xjfile://audio/${encodeURIComponent(m.audio)}`} controls preload="metadata" />
              )}
              {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
                <div className="sources">
                  {m.sources.map((s, i) => (
                    <a key={i} href={s.url} target="_blank" rel="noreferrer" title={s.snippet}>
                      [{i + 1}] {s.title.slice(0, 24)}
                    </a>
                  ))}
                </div>
              )}
              <Markdown text={m.content} />
              {m.role === 'assistant' && m.error && <div className="error-box">⚠ {m.error}</div>}
              {m.role === 'assistant' && m.aborted && (
                <div className="msg-aborted">
                  ⏹ 已停止生成{m.content.trim() ? ' · 以上内容不完整' : ' · 未产生内容'}
                </div>
              )}
            </div>
          ))}
          {st?.reasoning && (
            <div className="msg assistant">
              <div className="reasoning-box live">
                <div className="reasoning-toggle">💭 思考中…</div>
                <div className="reasoning-content">{st.reasoning}</div>
              </div>
            </div>
          )}
          {(st?.text || st?.status || st?.images?.length || st?.video || st?.audio) && (
            <div className="msg assistant">
              {st?.status && <div className="status-line">{st.status}</div>}
              {!!st?.images?.length && (
                <div className="msg-images">
                  {st.images.map((n) => (
                    <img key={n} src={`xjfile://img/${encodeURIComponent(n)}`} alt={n} />
                  ))}
                </div>
              )}
              {st?.video && (
                <video className="gen-video" src={`xjfile://video/${encodeURIComponent(st.video)}`} controls preload="metadata" />
              )}
              {st?.audio && (
                <audio className="gen-audio" src={`xjfile://audio/${encodeURIComponent(st.audio)}`} controls preload="metadata" />
              )}
              <Markdown text={st?.text ?? ''} />
            </div>
          )}
          {st?.error && <div className="error-box">⚠ {st.error}</div>}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          {attach.length > 0 && (
            <div className="attach-row">
              {attach.map((n) => (
                <span key={n} className="attach-thumb">
                  <img src={`xjfile://img/${encodeURIComponent(n)}`} alt="" />
                  <button
                    className="attach-del"
                    title="移除图片"
                    onClick={() => setAttach((a) => a.filter((x) => x !== n))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={input}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
                f.type.startsWith('image/')
              )
              if (!files.length) return
              e.preventDefault()
              void (async () => {
                for (const f of files.slice(0, 4 - attach.length)) {
                  const dataUrl = await new Promise<string>((res, rej) => {
                    const r = new FileReader()
                    r.onload = () => res(String(r.result))
                    r.onerror = () => rej(new Error('读取失败'))
                    r.readAsDataURL(f)
                  })
                  await addImageFromDataUrl(dataUrl)
                }
              })()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={2}
          />
          <div className="composer-bottom">
            {/* 对话进行中不显示 图片 / 联网：这会儿既发不了图、也不该中途切搜索，
                留着只会让人误点（参考 Codex 页生成时的处理） */}
            {!streaming && (
              <>
                <button
                  className="chip"
                  title="发送图片给模型（也可直接 Ctrl+V 粘贴）"
                  onClick={async () => {
                    try {
                      const dataUrl = await api.images.pick()
                      if (dataUrl) await addImageFromDataUrl(dataUrl)
                    } catch (e) {
                      alert('图片读取失败：' + String(e instanceof Error ? e.message : e))
                    }
                  }}
                >
                  📎 图片
                </button>
                <button
                  className={'chip' + (webSearchOn ? ' on' : '')}
                  onClick={() => setWebSearchOn((v) => !v)}
                  title="联网搜索"
                >
                  🌐 联网
                </button>
              </>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
              <ContextCircle used={usedTokens} budget={contextBudget} />
              <ModelPopover
                providers={(settings?.providers ?? []).filter(
                  (p) => (p.hasKey || p.id === 'ollama') && provStatus[p.id]?.ok !== false
                )}
                providerId={
                  (active?.target ?? draft.target)?.providerId ?? settings?.defaultProviderId ?? ''
                }
                model={(active?.target ?? draft.target)?.model ?? settings?.defaultModel ?? ''}
                level={active?.reasoningLevel ?? draft.level ?? 'off'}
                contextTokens={contextBudget}
                onChange={changeModel}
                onLevel={changeLevel}
                onContext={changeContext}
              />
              {streaming ? (
                <button className="send-btn stop" onClick={stop} title="停止">
                  ■
                </button>
              ) : (
                <button className="send-btn" onClick={send} disabled={!input.trim() && !attach.length} title="发送">
                  ↑
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {delTarget && (
        <ConfirmDialog
          title="删除会话"
          message={`删除「${delTarget.title}」？该会话的聊天记录和记忆会一并删除，不可恢复。`}
          onCancel={() => setDelTarget(null)}
          onConfirm={async () => {
            // 正在回复的会话先停掉，避免删完还在往这个会话里写
            if (streams[delTarget.id]) {
              api.chat.stop(delTarget.id)
              await new Promise((r) => setTimeout(r, 300))
            }
            await api.chat.deleteSession(delTarget.id)
            sendingRef.current.delete(delTarget.id)
            const rest = sessions.filter((x) => x.id !== delTarget.id)
            setSessions(rest)
            if (activeId === delTarget.id) setActiveId(rest[0]?.id ?? null)
            setDelTarget(null)
          }}
        />
      )}

      {delFolder && (
        <ConfirmDialog
          title="删除文件夹"
          message={`删除文件夹「${delFolder.name}」？其中的会话会移回未分类，不会丢失。`}
          onCancel={() => setDelFolder(null)}
          onConfirm={async () => {
            await removeFolder(delFolder.id)
            setDelFolder(null)
          }}
        />
      )}

      {folderPrompt && (
        <PromptDialog
          title="新建文件夹"
          placeholder="文件夹名称"
          okLabel="创建"
          onCancel={() => setFolderPrompt(false)}
          onOk={(v) => {
            setFolderPrompt(false)
            createFolder(v)
          }}
        />
      )}

      {ctxMenu &&
        (() => {
          const s = ctxMenu.kind === 'session' ? sessions.find((x) => x.id === ctxMenu.id) : null
          const f = ctxMenu.kind === 'folder' ? folders.find((x) => x.id === ctxMenu.id) : null
          if (!s && !f) return null
          const mx = Math.min(ctxMenu.x, window.innerWidth - 210)
          const my = Math.min(ctxMenu.y, window.innerHeight - 340)
          return (
            <div className="ctx-menu" style={{ left: mx, top: my }} onMouseDown={(e) => e.stopPropagation()}>
              {s && (
                <>
                  <button
                    onClick={() => {
                      startRename('session', s.id)
                      setCtxMenu(null)
                    }}
                  >
                    ✏️ 重命名
                  </button>
                  <button
                    onClick={() => {
                      patchSession(s.id, { pinned: !s.pinned })
                      setCtxMenu(null)
                    }}
                  >
                    📌 {s.pinned ? '取消置顶' : '置顶'}
                  </button>
                  {!s.archived && (
                    <>
                      <div className="ctx-label">分区</div>
                      {folders
                        .filter((f2) => f2.id !== s.folderId)
                        .map((f2) => (
                          <button
                            key={f2.id}
                            onClick={() => {
                              patchSession(s.id, { folderId: f2.id })
                              setCtxMenu(null)
                            }}
                          >
                            📁 {f2.name}
                          </button>
                        ))}
                      <button
                        onClick={() => {
                          setCtxMenu(null)
                          setFolderPrompt(true)
                        }}
                      >
                        ＋ 新建文件夹…
                      </button>
                      {hasFolder(s.folderId) && (
                        <button
                          onClick={() => {
                            patchSession(s.id, { folderId: undefined })
                            setCtxMenu(null)
                          }}
                        >
                          ↩️ 移出文件夹
                        </button>
                      )}
                      <div className="ctx-sep" />
                      <button
                        onClick={() => {
                          patchSession(s.id, { archived: true })
                          if (activeId === s.id) {
                            const next = live.find((x) => x.id !== s.id)
                            setActiveId(next ? next.id : null)
                          }
                          setCtxMenu(null)
                        }}
                      >
                        🗄️ 归档
                      </button>
                    </>
                  )}
                  {s.archived && (
                    <>
                      <button
                        onClick={() => {
                          patchSession(s.id, { archived: false })
                          setCtxMenu(null)
                        }}
                      >
                        📤 取消归档
                      </button>
                      <div className="ctx-sep" />
                    </>
                  )}
                  <div className="ctx-sep" />
                  <button
                    className="danger"
                    onClick={() => {
                      setDelTarget(s)
                      setCtxMenu(null)
                    }}
                  >
                    🗑️ 删除会话
                  </button>
                </>
              )}
              {f && (
                <>
                  <button
                    onClick={() => {
                      startRename('folder', f.id)
                      setCtxMenu(null)
                    }}
                  >
                    ✏️ 重命名文件夹
                  </button>
                  <div className="ctx-sep" />
                  <button
                    className="danger"
                    onClick={() => {
                      setDelFolder(f)
                      setCtxMenu(null)
                    }}
                  >
                    🗑️ 删除文件夹
                  </button>
                </>
              )}
            </div>
          )
        })()}
    </div>
  )
}

// ---------- 模型选择 ----------

function ModelPicker({
  settings,
  target,
  onChange
}: {
  settings: AppSettings | null
  target: LLMTarget | null
  onChange: (providerId: string, model: string) => void
}) {
  const provStatus = useProvStatus()
  if (!settings || !target) return <span className="dim">未选择模型</span>
  // 只显示已就绪的供应商：配置了 Key 的云端（连接测试未失败）或本地 Ollama
  const available = settings.providers.filter(
    (p) => (p.hasKey || p.id === 'ollama') && provStatus[p.id]?.ok !== false
  )
  const provider = settings.providers.find((p) => p.id === target.providerId)
  const currentReady = provider && (provider.hasKey || provider.id === 'ollama')
  if (!available.length) {
    return <span className="dim">请先在设置中配置模型（API Key 或本地 Ollama）</span>
  }
  return (
    <div className="model-picker">
      <select
        value={target.providerId}
        onChange={(e) => {
          const p = settings.providers.find((x) => x.id === e.target.value)
          if (p) onChange(p.id, p.models[0] ?? '')
        }}
      >
        {!currentReady && <option value={target.providerId}>{(provider?.name ?? target.providerId) + '（未配置）'}</option>}
        {available.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select value={target.model} onChange={(e) => onChange(target.providerId, e.target.value)}>
        {(provider?.models ?? []).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        {!provider?.models.includes(target.model) && <option value={target.model}>{target.model}</option>}
      </select>
    </div>
  )
}

// ---------- 轻量 Markdown 渲染（代码块 + 行内格式） ----------

export function Markdown({ text }: { text: string }) {
  if (!text) return null
  const blocks = text.split(/```/)
  return (
    <div className="md">
      {blocks.map((b, i) =>
        i % 2 === 1 ? (
          <pre key={i}>
            <code>{b.replace(/^[a-z]*\n/, '')}</code>
          </pre>
        ) : (
          <InlineMd key={i} text={b} />
        )
      )}
    </div>
  )
}

function InlineMd({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, i) => {
        let html = line
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          // 本地图片（生图结果等）：![描述](xjfile://img/xxx.png) → <img>，需在转义之后插入
          .replace(/!\[([^\]]*)\]\(xjfile:\/\/img\/([^\s)]+)\)/g, (_m, alt, name) => {
            const src = `xjfile://img/${name}`
            const safeAlt = String(alt).replace(/"/g, '&quot;')
            return `<img class="md-img" src="${src}" alt="${safeAlt}" />`
          })
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/^\s*[-*]\s+(.*)$/, '• $1')
          .replace(/^###?\s+(.*)$/, '<strong>$1</strong>')
        html = html || '&nbsp;'
        return <div key={i} dangerouslySetInnerHTML={{ __html: html }} />
      })}
    </>
  )
}
