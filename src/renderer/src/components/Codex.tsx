import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, AppSettings, CodexSession, ChatFolder, LLMTarget } from '../api'
import { Markdown } from './Chat'
import { useSidebarWidth } from '../useSidebarWidth'
import { Trash, Gear } from './Icons'
import ConfirmDialog from './ConfirmDialog'
import PromptDialog from './PromptDialog'
import ModelPopover, { ReasoningLevel } from './ModelPopover'
import ModeMenu, { Tab } from './ModeMenu'
import { useProvStatus } from '../providerStatus'
import ContextCircle from './ContextCircle'
import { estimateTokens } from '../ctx'

interface Props {
  settings: AppSettings | null
  tab: Tab
  onTab: (t: Tab) => void
  onSettings: () => void
}

/** 任务流里的一条：用户消息 / 助手消息 / 工具卡片 */
interface LogItem {
  kind: 'user' | 'assistant' | 'tool' | 'error'
  text?: string
  name?: string
  detail?: string
  result?: string
  running?: boolean
}

/** 把磁盘上的任务历史还原成对话流（只含用户/助手文本；协议性消息不回显） */
const PROTOCOL_LINES = new Set(['已批准计划，开始执行。', '用户拒绝了计划，请按反馈调整后重新给一份计划。'])
function historyToLogs(history: { role: 'user' | 'assistant'; content: string }[]): LogItem[] {
  const out: LogItem[] = []
  for (const h of history) {
    const text = (h.content ?? '').trim()
    if (!text || PROTOCOL_LINES.has(text)) continue
    out.push(h.role === 'user' ? { kind: 'user', text } : { kind: 'assistant', text })
  }
  return out
}

const TOOL_META: Record<string, { icon: string; label: string }> = {  read_file: { icon: '📄', label: '读取文件' },
  write_file: { icon: '✏️', label: '写入文件' },
  list_dir: { icon: '🗂', label: '查看目录' },
  run_command: { icon: '▶', label: '执行命令' },
  web_search: { icon: '🌐', label: '联网搜索' }
}

/** 访问权限三档（对应 Codex 的权限选择） */
type Access = 'readonly' | 'standard' | 'full'
const ACCESS_LABEL: Record<Access, string> = {
  readonly: '🔒 只读',
  standard: '🛡 改动前问我',
  full: '⚡ 完全访问'
}

function accessOf(s: CodexSession): Access {
  return s.readonly ? 'readonly' : s.autoApprove ? 'full' : 'standard'
}

function toolTarget(name: string, detail: string): string {
  try {
    const j = JSON.parse(detail || '{}')
    return j.file ?? j.command ?? j.query ?? j.dir ?? ''
  } catch {
    return detail.slice(0, 60)
  }
}

/** 切页会卸载重挂：记住当前任务，回来接着看（进程内有效，重启从头开始） */
let cachedCodexId: string | null = null

export default function Codex({ settings, tab, onTab, onSettings }: Props) {
  const side = useSidebarWidth('codex', 250, 200, 420)
  const provStatus = useProvStatus()
  const [sessions, setSessions] = useState<CodexSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(cachedCodexId)
  useEffect(() => {
    cachedCodexId = activeId
  }, [activeId])
  // 任务可能已被删：列表回来后校验
  useEffect(() => {
    if (activeId && sessions.length && !sessions.some((s) => s.id === activeId)) setActiveId(null)
  }, [sessions, activeId])
  // 切页回来恢复「执行中」占位（任务其实还在跑）
  useEffect(() => {
    if (!activeId) return
    let alive = true
    api.codex
      .active()
      .then((ids: string[]) => {
        if (alive && ids.includes(activeId)) {
          setStreams((m) => (m[activeId] !== undefined ? m : { ...m, [activeId]: '' }))
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [activeId])
  const [logs, setLogs] = useState<Record<string, LogItem[]>>({})
  const [streams, setStreams] = useState<Record<string, string>>({}) // 每任务独立的流式文本
  const [approval, setApproval] = useState<{ approvalId: string; detail: string; sessionId: string } | null>(null)
  const [error, setError] = useState('')
  const [delTask, setDelTask] = useState<CodexSession | null>(null)
  const [openTools, setOpenTools] = useState<Record<number, boolean>>({})
  const [folders, setFolders] = useState<ChatFolder[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; kind: 'task' | 'folder'; id: string } | null>(null)
  const [renaming, setRenaming] = useState<{ kind: 'task' | 'folder'; id: string } | null>(null)
  const [renameText, setRenameText] = useState('')
  const [delFolder, setDelFolder] = useState<ChatFolder | null>(null)
  const [folderPrompt, setFolderPrompt] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // —— 新任务草稿（Codex 式：起点就是一个聊天框）——
  const [draft, setDraft] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [providerId, setProviderId] = useState<string>(settings?.defaultProviderId ?? 'ollama')
  const [model, setModel] = useState<string>(settings?.defaultModel ?? '')
  const [access, setAccess] = useState<Access>('standard')
  const [level, setLevel] = useState<ReasoningLevel>('off')
  const [ctx, setCtx] = useState<number>(0) // 新任务的上下文预算（0 = 尚未初始化）

  useEffect(() => {
    if (settings && !ctx) setCtx(settings.codexTokens ?? settings.memoryTokens)
  }, [settings])

  // settings 异步到达后补默认值
  useEffect(() => {
    if (settings && !model) {
      setProviderId(settings.defaultProviderId)
      setModel(settings.defaultModel)
    }
  }, [settings])

  const reloadSessions = useCallback(() => {
    api.codex.listSessions().then((s) => setSessions(s))
  }, [])
  useEffect(() => {
    reloadSessions()
    api.codex.listFolders().then(setFolders)
  }, [reloadSessions])

  useEffect(() => {
    const off = api.codex.onEvent((e: any) => {
      const sid: string = e.sessionId
      if (!sid) return
      switch (e.type) {
        case 'user-saved':
          setLogs((m) => ({ ...m, [sid]: [...(m[sid] ?? []), { kind: 'user', text: e.content }] }))
          break
        case 'delta':
          setStreams((m) => ({ ...m, [sid]: (m[sid] ?? '') + e.text }))
          break
        case 'done': {
          const text = streamsRef.current[sid] ?? ''
          if (text.trim()) {
            setLogs((m) => ({ ...m, [sid]: [...(m[sid] ?? []), { kind: 'assistant', text }] }))
          }
          setStreams((m) => {
            const copy = { ...m }
            delete copy[sid]
            return copy
          })
          break
        }
        case 'tool-start':
          setLogs((m) => ({
            ...m,
            [sid]: [...(m[sid] ?? []), { kind: 'tool', name: e.name, detail: e.detail, running: true }]
          }))
          break
        case 'tool-result':
          setLogs((m) => {
            const list = [...(m[sid] ?? [])]
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i].kind === 'tool' && list[i].running && list[i].name === e.name) {
                list[i] = { ...list[i], result: e.result, running: false }
                break
              }
            }
            return { ...m, [sid]: list }
          })
          break
        case 'approval':
          setApproval({ approvalId: e.approvalId, detail: e.detail, sessionId: sid })
          break
        case 'error':
          // 原来把提示写进 streams 之后马上把整条流删掉，错误永远看不到；
          // 现在作为一条 error 记录进对话流，位置对也不会被清掉
          if (e.message !== '__aborted__') {
            setLogs((m) => ({ ...m, [sid]: [...(m[sid] ?? []), { kind: 'error', text: e.message }] }))
          }
          setStreams((m) => {
            const copy = { ...m }
            delete copy[sid]
            return copy
          })
          break
        case 'session-title':
          reloadSessions()
          break
        case 'end':
          setStreams((m) => {
            const copy = { ...m }
            delete copy[sid]
            return copy
          })
          break
      }
    })
    return off
  }, [])

  const streamsRef = useRef<Record<string, string>>({})
  streamsRef.current = streams

  const active = sessions.find((s) => s.id === activeId) ?? null

  // 从磁盘打开已有任务时回填历史：以前只有实时事件流才会写 logs，
  // 切走再切回 / 重启应用后对话区一片空白（模型其实还记得，用户看不到）
  useEffect(() => {
    if (!activeId) return
    const s = sessions.find((x) => x.id === activeId)
    if (!s?.history?.length) return
    setLogs((m) => (m[activeId]?.length ? m : { ...m, [activeId]: historyToLogs(s.history!) }))
  }, [activeId, sessions])
  const availableProviders = (settings?.providers ?? []).filter(
    (p) => (p.hasKey || p.id === 'ollama') && provStatus[p.id]?.ok !== false
  )
  const draftProvider = availableProviders.find((p) => p.id === providerId)
  const draftModels = draftProvider?.models ?? []

  const pickDir = useCallback(async () => {
    const dir = await api.settings.pickWorkDir()
    if (dir) setWorkdir(dir)
  }, [])

  /** 发出第一条消息 = 创建任务并开始执行（Codex 式）；不选工作区则用默认工作区 */
  // 连点会连建好几个任务 → ref 同步闸门（streams 是异步 state，同一帧拦不住）
  const sendingRef = useRef(false)
  const startTask = useCallback(async () => {
    const text = draft.trim()
    if (!text || sendingRef.current) return
    sendingRef.current = true
    try {
      const target: LLMTarget = { providerId, model }
      const s = await api.codex.createSession(workdir.trim(), target)
      await api.codex.updateSession(s.id, {
        readonly: access === 'readonly',
        autoApprove: access === 'full',
        reasoningLevel: level,
        contextTokens: ctx || settings?.codexTokens || settings?.memoryTokens,
        target
      })
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      setLogs((m) => ({ ...m, [s.id]: [] }))
      setStreams((m) => ({ ...m, [s.id]: '' })) // 占位：按钮立刻变为停止
      setDraft('')
      api.codex.send({ sessionId: s.id, userText: text })
    } finally {
      sendingRef.current = false
    }
  }, [draft, workdir, providerId, model, access])

  const sendFollowUp = useCallback(async () => {
    const text = draft.trim()
    if (!text || !active || streams[active.id] !== undefined || sendingRef.current) return
    sendingRef.current = true
    try {
      setDraft('')
      setStreams((m) => ({ ...m, [active.id]: '' }))
      api.codex.send({ sessionId: active.id, userText: text })
    } finally {
      sendingRef.current = false
    }
  }, [draft, streams, active])

  const changeModel = useCallback(
    async (pid: string, m: string) => {
      setProviderId(pid)
      setModel(m)
      if (active) {
        const u = await api.codex.updateSession(active.id, { target: { providerId: pid, model: m } })
        setSessions((prev) => prev.map((s) => (s.id === u.id ? u : s)))
      }
    },
    [active]
  )

  const changeLevel = useCallback(
    async (l: ReasoningLevel) => {
      setLevel(l)
      if (active) {
        const u = await api.codex.updateSession(active.id, { reasoningLevel: l })
        setSessions((prev) => prev.map((s) => (s.id === u.id ? u : s)))
      }
    },
    [active]
  )

  const changeAccess = useCallback(
    async (a: Access) => {
      setAccess(a)
      if (active) {
        const u = await api.codex.updateSession(active.id, {
          readonly: a === 'readonly',
          autoApprove: a === 'full'
        })
        setSessions((prev) => prev.map((s) => (s.id === u.id ? u : s)))
      }
    },
    [active]
  )

  const changeContext = useCallback(
    async (n: number) => {
      setCtx(n)
      if (active) {
        const u = await api.codex.updateSession(active.id, { contextTokens: n })
        setSessions((prev) => prev.map((s) => (s.id === u.id ? u : s)))
      }
    },
    [active]
  )

  // 上下文预算与用量（新任务用草稿值，任务内用会话值）
  const contextBudget = active
    ? active.contextTokens ?? settings?.codexTokens ?? settings?.memoryTokens ?? 32768
    : ctx || settings?.codexTokens || settings?.memoryTokens || 32768
  const usedTokens = useMemo(
    () =>
      active
        ? estimateTokens((active.summary ?? '') + (active.history ?? []).map((h) => h.content).join(''))
        : 0,
    [active]
  )

  const openTask = (id: string) => {
    setActiveId(id)
    setError('')
    const s = sessions.find((x) => x.id === id)
    if (s) {
      setProviderId(s.target.providerId)
      setModel(s.target.model)
      setAccess(accessOf(s))
      setLevel(s.reasoningLevel ?? 'off')
    }
  }

  const newTask = () => {
    setActiveId(null)
    setDraft('')
    setWorkdir('')
    setAccess('standard')
    setLevel('off')
  }

  // 派生：当前任务的日志与流式状态（各任务独立，切换不打架）
  const log = activeId ? logs[activeId] ?? [] : []
  const streamText = activeId ? streams[activeId] ?? '' : ''
  const streaming = !!(activeId && streams[activeId] !== undefined)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [log, streams, approval])

  // ---------- 任务列表：置顶 / 文件夹 / 归档 / 右键菜单 ----------

  const live = sessions.filter((s) => !s.archived)
  const archivedList = sessions.filter((s) => s.archived)
  const pinnedList = live.filter((s) => s.pinned)
  const hasFolder = (id?: string | null) => !!id && folders.some((f) => f.id === id)
  const unfiled = live.filter((s) => !s.pinned && !hasFolder(s.folderId))
  const inFolder = (fid: string) => live.filter((s) => !s.pinned && s.folderId === fid)
  const toggleSection = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))

  const patchTask = useCallback(async (id: string, patch: Partial<CodexSession>) => {
    const updated = await api.codex.updateSession(id, patch)
    setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }, [])

  const startRename = (kind: 'task' | 'folder', id: string) => {
    const cur =
      kind === 'task' ? sessions.find((s) => s.id === id)?.title : folders.find((f) => f.id === id)?.name
    setRenaming({ kind, id })
    setRenameText(cur ?? '')
  }

  const commitRename = useCallback(async () => {
    if (!renaming) return
    const name = renameText.trim()
    if (name) {
      if (renaming.kind === 'task') {
        await patchTask(renaming.id, { title: name })
      } else {
        const f = await api.codex.renameFolder(renaming.id, name)
        setFolders((prev) => prev.map((x) => (x.id === f.id ? f : x)))
      }
    }
    setRenaming(null)
  }, [renaming, renameText, patchTask])

  const createFolder = useCallback(async (name: string) => {
    if (!name.trim()) return
    const f = await api.codex.createFolder(name.trim())
    setFolders((prev) => [...prev, f])
  }, [])

  const removeFolder = useCallback(async (id: string) => {
    await api.codex.deleteFolder(id)
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

  const renderItem = (s: CodexSession) => (
    <div
      key={s.id}
      className={'codex-task' + (s.id === activeId ? ' active' : '')}
      onClick={() => openTask(s.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'task', id: s.id })
      }}
    >
      {renaming?.kind === 'task' && renaming.id === s.id ? (
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
          <div className="codex-task-name">{s.title}</div>
          <div className="codex-task-dir mono">
            {s.readonly ? '🔒' : s.autoApprove ? '⚡' : '🛡'} {s.workdir}
          </div>
        </>
      )}
      <button
        className="session-del"
        title="删除任务"
        onClick={(e) => {
          e.stopPropagation()
          setDelTask(s)
        }}
      >
        <Trash />
      </button>
    </div>
  )

  return (
    <div className="codex-layout">
      <aside
        className={'codex-side' + (side.dragging ? ' dragging' : '')}
        style={{ width: side.width }}
      >
        <div className="side-resizer" onMouseDown={side.onDown} />
        <div className="side-head">
          <ModeMenu tab={tab} onChange={onTab} />
          <div className="side-head-actions">
            <button className="icon-btn" title="设置" onClick={onSettings}>
              <Gear />
            </button>
          </div>
        </div>
        <button className="btn primary full" onClick={newTask}>
          ＋ 新任务
        </button>
        <div className="codex-task-list">
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
          {sessions.length === 0 && <div className="codex-side-empty dim">还没有任务</div>}
        </div>
      </aside>

      <section className="codex-main">
        {active ? (
          <>
            <div className="codex-topbar">
              <span className="codex-topbar-name">{active.title}</span>
              <span className="workdir-chip mono" title={active.workdir}>
                {active.workdir}
              </span>
            </div>

            <div className="codex-stream">
              {log.map((item, i) =>
                item.kind === 'user' ? (
                  <div key={i} className="msg user">
                    {item.text}
                  </div>
                ) : item.kind === 'assistant' ? (
                  <div key={i} className="msg assistant">
                    <Markdown text={item.text ?? ''} />
                  </div>
                ) : item.kind === 'error' ? (
                  <div key={i} className="error-box">
                    ⚠ {item.text}
                  </div>
                ) : (
                  <div key={i} className="tool-card">
                    <button
                      className="tool-card-head"
                      onClick={() => setOpenTools((v) => ({ ...v, [i]: !v[i] }))}
                    >
                      <span className="tool-card-icon">
                        {TOOL_META[item.name ?? '']?.icon ?? '🔧'}
                      </span>
                      <span className="tool-card-label">
                        {TOOL_META[item.name ?? '']?.label ?? item.name}
                      </span>
                      <span className="tool-card-target mono">
                        {toolTarget(item.name ?? '', item.detail ?? '')}
                      </span>
                      {item.running ? (
                        <span className="tool-card-status running">执行中…</span>
                      ) : (
                        <span className="tool-card-status done">完成</span>
                      )}
                      <span className="tool-card-arrow">{openTools[i] ? '▾' : '▸'}</span>
                    </button>
                    {openTools[i] && item.result && (
                      <pre className="tool-card-body">
                        <code>{item.result}</code>
                      </pre>
                    )}
                  </div>
                )
              )}

              {streamText && (
                <div className="msg assistant">
                  <Markdown text={streamText} />
                </div>
              )}
              {streaming && !streamText && (
                <div className="codex-working">
                  <span className="codex-working-dot" />
                  <span className="codex-working-dot" />
                  <span className="codex-working-dot" />
                </div>
              )}

              {approval && approval.sessionId === activeId && (
                <div className="approval-card">
                  <div className="approval-card-head">🔐 需要你的批准</div>
                  <div className="approval-card-body mono">{approval.detail}</div>
                  <div className="approval-card-actions">
                    <button
                      className="btn primary sm"
                      onClick={() => {
                        api.codex.approve(approval.approvalId, true)
                        setApproval(null)
                      }}
                    >
                      批准
                    </button>
                    <button
                      className="btn sm"
                      onClick={() => {
                        api.codex.approve(approval.approvalId, false)
                        setApproval(null)
                      }}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              )}

              {error && <div className="error-box">⚠ {error}</div>}
              <div ref={bottomRef} />
            </div>

            {/* 任务内输入框：模型 / 权限 / 计划 都在框内（Codex 式） */}
            <div className="composer">
              <textarea
                value={draft}
                placeholder={streaming ? '任务执行中…' : '继续交代…（Enter 发送）'}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendFollowUp()
                  }
                }}
                rows={2}
              />
              <div className="composer-bottom">
                <div className="pill-group">
                  <select
                    className="pill-select"
                    value={access}
                    onChange={(e) => changeAccess(e.target.value as Access)}
                    title="访问权限"
                  >
                    <option value="readonly">🔒 只读</option>
                    <option value="standard">🛡 改动前问我</option>
                    <option value="full">⚡ 完全访问</option>
                  </select>
                  <button
                    className={'chip' + (active.planMode ? ' on' : '')}
                    onClick={async () => {
                      const u = await api.codex.updateSession(active.id, { planMode: !active.planMode })
                      setSessions((prev) => prev.map((s) => (s.id === u.id ? u : s)))
                    }}
                    title="先出计划，你批准后才开始动手"
                  >
                    先出计划
                  </button>
                </div>
                <div className="pill-group" style={{ marginLeft: 'auto' }}>
                  <ContextCircle used={usedTokens} budget={contextBudget} />
                  <ModelPopover
                    providers={availableProviders}
                    providerId={providerId}
                    model={model}
                    level={active.reasoningLevel ?? level}
                    contextTokens={contextBudget}
                    onChange={changeModel}
                    onLevel={changeLevel}
                    onContext={changeContext}
                  />
                  {streaming ? (
                    <button
                      className="send-btn stop"
                      onClick={() => active && api.codex.stop(active.id)}
                      title="停止"
                    >
                      ■
                    </button>
                  ) : (
                    <button
                      className="send-btn"
                      onClick={sendFollowUp}
                      disabled={!draft.trim()}
                      title="发送"
                    >
                      ↑
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          /* ============ 新任务：居中大聊天框（Codex 起始页） ============ */
          <div className="codex-hero">
            <div className="codex-hero-title">小镜 Codex</div>
            <div className="composer codex-hero-composer">
              <textarea
                value={draft}
                placeholder="描述一个任务，比如「读一下这个项目的 README，然后加一个安装脚本」"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    startTask()
                  }
                }}
                rows={4}
                autoFocus
              />
              <div className="composer-bottom">
                <div className="pill-group">
                  <button className="pill-select as-btn" onClick={pickDir} title="选择工作目录（不选则用默认工作区）">
                    📁 {workdir ? workdir.split(/[\\/]/).pop() : '默认工作区'}
                  </button>
                  <select
                    className="pill-select"
                    value={access}
                    onChange={(e) => setAccess(e.target.value as Access)}
                    title="访问权限"
                  >
                    <option value="readonly">🔒 只读</option>
                    <option value="standard">🛡 改动前问我</option>
                    <option value="full">⚡ 完全访问</option>
                  </select>
                </div>
                <div className="pill-group" style={{ marginLeft: 'auto' }}>
                  <ContextCircle used={usedTokens} budget={contextBudget} />
                  <ModelPopover
                    providers={availableProviders}
                    providerId={providerId}
                    model={model}
                    level={level}
                    contextTokens={contextBudget}
                    onChange={changeModel}
                    onLevel={setLevel}
                    onContext={changeContext}
                  />
                  <button
                    className="send-btn"
                    onClick={startTask}
                    disabled={!draft.trim()}
                    title="发送"
                  >
                    ↑
                  </button>
                </div>
              </div>
            </div>
            <div className="codex-hero-hint dim">
              {workdir
                ? `工作区：${workdir}`
                : '未选工作区 · 将使用默认工作区 D:\\小镜codex默认，点左下角可更换'}
            </div>
          </div>
        )}
      </section>

      {delTask && (
        <ConfirmDialog
          title="删除任务"
          message={`删除任务「${delTask.title}」？执行记录会一并删除，工作区里的文件不受影响。`}
          onCancel={() => setDelTask(null)}
          onConfirm={async () => {
            await api.codex.deleteSession(delTask.id)
            const rest = sessions.filter((t) => t.id !== delTask.id)
            setSessions(rest)
            if (activeId === delTask.id) setActiveId(null)
            setDelTask(null)
          }}
        />
      )}

      {delFolder && (
        <ConfirmDialog
          title="删除文件夹"
          message={`删除文件夹「${delFolder.name}」？其中的任务会移回未分类，不会丢失。`}
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
          const s = ctxMenu.kind === 'task' ? sessions.find((x) => x.id === ctxMenu.id) : null
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
                      startRename('task', s.id)
                      setCtxMenu(null)
                    }}
                  >
                    ✏️ 重命名
                  </button>
                  <button
                    onClick={() => {
                      patchTask(s.id, { pinned: !s.pinned })
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
                              patchTask(s.id, { folderId: f2.id })
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
                            patchTask(s.id, { folderId: undefined })
                            setCtxMenu(null)
                          }}
                        >
                          ↩️ 移出文件夹
                        </button>
                      )}
                      <div className="ctx-sep" />
                      <button
                        onClick={() => {
                          patchTask(s.id, { archived: true })
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
                          patchTask(s.id, { archived: false })
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
                      setDelTask(s)
                      setCtxMenu(null)
                    }}
                  >
                    🗑️ 删除任务
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

