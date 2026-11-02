import { useCallback, useEffect, useRef, useState } from 'react'
import { api, AppSettings, Bot, BotMsg, Group, LLMTarget } from '../api'
import { useSidebarWidth } from '../useSidebarWidth'
import ModeMenu, { Tab } from './ModeMenu'
import { Trash, Gear } from './Icons'
import ConfirmDialog from './ConfirmDialog'
import AvatarCropper from './AvatarCropper'
import { useProvStatus } from '../providerStatus'

interface Props {
  settings: AppSettings | null
  tab: Tab
  onTab: (t: Tab) => void
  onSettings: () => void
}

/** 每个 bot 一个专属渐变色（由 id 决定，稳定不变） */
function botGradient(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return `linear-gradient(135deg, hsl(${h}, 72%, 62%), hsl(${(h + 45) % 360}, 68%, 48%))`
}

/** 人设标语 = 人格设定的第一句话 */
function tagline(persona: string): string {
  const first = persona.split(/[。\n.!?！？]/)[0] ?? ''
  return first.slice(0, 26) || 'AI 伙伴'
}

function Avatar({ bot, size = 40 }: { bot: Bot; size?: number }) {
  if (isCustomAvatar(bot.avatar)) {
    return (
      <img
        className="bot-grad-avatar bot-img-avatar"
        style={{ width: size, height: size }}
        src={customAvatarUrl(bot.avatar)}
        alt=""
      />
    )
  }
  // 历史遗留的 emoji 形象仍显示；新机器人无头像时显示渐变底 + 名字首字
  const legacyEmoji = bot.avatar && bot.avatar.length <= 8 ? bot.avatar : ''
  const initial = (bot.name || '？').trim().charAt(0) || '？'
  return (
    <span
      className="bot-grad-avatar"
      style={{ width: size, height: size, background: botGradient(bot.id), fontSize: size * 0.42 }}
    >
      {legacyEmoji || initial}
    </span>
  )
}

/** 自定义图片头像存在数据目录 avatars/ 下，bot.avatar 形如 avatars/av_xxx.png */
function isCustomAvatar(a: string): boolean {
  return a.startsWith('avatars/')
}

function customAvatarUrl(a: string): string {
  return `xjfile://avatar/${encodeURIComponent(a.slice('avatars/'.length))}`
}

/** 切页会卸载重挂：记住当前打开的是哪个伙伴/群，回来不用重新找 */
let cachedBotsView: { type: 'bot' | 'group'; id: string } | null = null

export default function Bots({ settings, tab, onTab, onSettings }: Props) {
  const side = useSidebarWidth('bots', 280, 220, 420)
  const [bots, setBots] = useState<Bot[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [view, setView] = useState<{ type: 'bot' | 'group'; id: string } | null>(cachedBotsView)
  useEffect(() => {
    cachedBotsView = view
  }, [view])
  const [showEditor, setShowEditor] = useState(false)
  const [editing, setEditing] = useState<Bot | null>(null)
  const [showGroupNew, setShowGroupNew] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newWrapRef = useRef<HTMLDivElement>(null)
  const [delBot, setDelBot] = useState<Bot | null>(null)
  const [delGroup, setDelGroup] = useState<Group | null>(null)

  const refresh = useCallback(async () => {
    // 两个列表分别取：任一个失败也不该把另一个的刷新连带吞掉（建群后侧栏空过一次就是这个坑）
    const [b, g] = await Promise.allSettled([api.bots.list(), api.groups.list()])
    if (b.status === 'fulfilled') setBots(b.value)
    if (g.status === 'fulfilled') setGroups(g.value)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!newMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (newWrapRef.current && !newWrapRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [newMenuOpen])

  const newBot = () => {
    const target: LLMTarget = settings
      ? { providerId: settings.defaultProviderId, model: settings.defaultModel }
      : { providerId: 'ollama', model: 'llama3' }
    setEditing({
      id: 'b_' + Date.now().toString(36),
      name: '',
      avatar: '',
      persona: '',
      target,
      createdAt: Date.now()
    })
    setShowEditor(true)
  }

  return (
    <div className="bots-layout">
      <aside
        className={'bots-side' + (side.dragging ? ' dragging' : '')}
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

        <div className="dropdown-wrap side-new-wrap" ref={newWrapRef}>
          <button className="btn primary full" onClick={() => setNewMenuOpen((v) => !v)}>
            ＋ 新建
          </button>
          {newMenuOpen && (
            <div className="dropdown-menu">
              <button
                type="button"
                onClick={() => {
                  setNewMenuOpen(false)
                  newBot()
                }}
              >
                ✨ 创建伙伴
              </button>
              <button
                type="button"
                disabled={bots.length === 0}
                title={bots.length === 0 ? '先创建一个伙伴' : ''}
                onClick={() => {
                  setNewMenuOpen(false)
                  setShowGroupNew(true)
                }}
              >
                👥 创建群聊
              </button>
            </div>
          )}
        </div>

        <div className="bot-gallery">
          {bots.map((b) => (
            <div
              key={b.id}
              className={'bot-card' + (view?.type === 'bot' && view.id === b.id ? ' active' : '')}
              onClick={() => setView({ type: 'bot', id: b.id })}
            >
              <Avatar bot={b} size={44} />
              <div className="bot-card-info">
                <div className="bot-card-name">{b.name}{b.preset && <span className="preset-badge" title="官方拟人形象">✦</span>}</div>
                <div className="bot-card-tag">{tagline(b.persona)}</div>
              </div>
              <button
                className="session-del"
                title="删除伙伴"
                onClick={(e) => {
                  e.stopPropagation()
                  setDelBot(b)
                }}
              >
                <Trash />
              </button>
            </div>
          ))}
          {bots.length === 0 && (
            <button className="bot-card-create" onClick={newBot}>
              <span className="bot-card-create-plus">＋</span>
              <div className="bot-card-info">
                <div className="bot-card-name">创建你的第一个伙伴</div>
                <div className="bot-card-tag">有性格，会记住你</div>
              </div>
            </button>
          )}
        </div>

        {groups.length > 0 && (
          <>
            <div className="sidebar-divider">群聊</div>
            <div className="session-list">
              {groups.map((g) => (
                <div
                  key={g.id}
                  className={
                    'session-item' + (view?.type === 'group' && view.id === g.id ? ' active' : '')
                  }
                  onClick={() => setView({ type: 'group', id: g.id })}
                >
                  <span className="session-title">👥 {g.name}</span>
                  <button
                    className="session-del"
                    title="删除群聊"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDelGroup(g)
                    }}
                  >
                    <Trash />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      <section className="chat-main">
        {showEditor && editing ? (
          <BotEditor
            bot={editing}
            settings={settings}
            onDone={async () => {
              setShowEditor(false)
              refresh()
            }}
          />
        ) : showGroupNew ? (
          <GroupNew
            bots={bots}
            onDone={async (created) => {
              setShowGroupNew(false)
              await refresh()
              // 建完直接进新群：以前只关弹窗，侧栏状态还停在旧列表，用户得手动刷新才看得到
              if (created) setView({ type: 'group', id: created.id })
            }}
          />
        ) : view?.type === 'bot' ? (
          <BotChat
            bot={bots.find((b) => b.id === view.id) ?? null}
            onEdit={(b) => {
              setEditing(b)
              setShowEditor(true)
            }}
          />
        ) : view?.type === 'group' ? (
          <GroupChat group={groups.find((g) => g.id === view.id) ?? null} bots={bots} />
        ) : (
          <div className="empty-hint">
            <div className="empty-logo">✨</div>
            <p>创建一个有性格、有记忆的伙伴</p>
            <p className="dim" style={{ marginTop: 6, fontSize: 13 }}>
              TA 会一直记得你们聊过的一切
            </p>
          </div>
        )}
      </section>

      {delBot && (
        <ConfirmDialog
          title="删除伙伴"
          message={`和「${delBot.name}」告别？TA 的全部聊天和长期记忆会一起删除，不可恢复。`}
          onCancel={() => setDelBot(null)}
          onConfirm={async () => {
            // 正在回复的话先停，否则流式回调会往已删除的伙伴里写
            api.bots.stop(delBot.id)
            await new Promise((r) => setTimeout(r, 250))
            await api.bots.delete(delBot.id)
            refresh()
            if (view?.type === 'bot' && view.id === delBot.id) setView(null)
            setDelBot(null)
          }}
        />
      )}

      {delGroup && (
        <ConfirmDialog
          title="删除群聊"
          message={`删除群「${delGroup.name}」？群聊记录会一并删除，成员伙伴不受影响。`}
          onCancel={() => setDelGroup(null)}
          onConfirm={async () => {
            api.groups.stop(delGroup.id)
            await new Promise((r) => setTimeout(r, 250))
            await api.groups.delete(delGroup.id)
            refresh()
            if (view?.type === 'group' && view.id === delGroup.id) setView(null)
            setDelGroup(null)
          }}
        />
      )}
    </div>
  )
}

// ---------- 伙伴编辑（Grok 式：先选形象，再起名字） ----------

function BotEditor({
  bot,
  settings,
  onDone
}: {
  bot: Bot
  settings: AppSettings | null
  onDone: () => void
}) {
  const [b, setB] = useState(bot)
  const [cropSrc, setCropSrc] = useState<string | null>(null) // 待框选的原图（data URL）
  const [viewingAvatar, setViewingAvatar] = useState(false) // 头像大图查看
  const provStatus = useProvStatus()
  const provider = settings?.providers.find((p) => p.id === b.target.providerId)
  const availableProviders = (settings?.providers ?? []).filter(
    (p) => (p.hasKey || p.id === 'ollama') && provStatus[p.id]?.ok !== false
  )

  const pickAvatar = async () => {
    try {
      const dataUrl = await api.avatars.pick()
      if (dataUrl) setCropSrc(dataUrl)
    } catch {
      /* 用户取消或选择失败 */
    }
  }

  return (
    <div className="bot-editor">
      <div className="bot-editor-hero">
        <button
          type="button"
          className="bot-editor-hero-btn"
          title={isCustomAvatar(b.avatar) ? '点击查看大图' : '点击上传头像'}
          onClick={() => (isCustomAvatar(b.avatar) ? setViewingAvatar(true) : pickAvatar())}
        >
          {isCustomAvatar(b.avatar) ? (
            <img className="bot-editor-hero-avatar bot-img-avatar" src={customAvatarUrl(b.avatar)} alt="" />
          ) : (
            <span
              className="bot-editor-hero-avatar"
              style={{ background: b.id ? botGradient(b.id) : undefined }}
            >
              {b.avatar && b.avatar.length <= 8 ? b.avatar : (b.name || '？').trim().charAt(0) || '？'}
            </span>
          )}
          {!isCustomAvatar(b.avatar) && <span className="bot-editor-hero-hint">上传</span>}
        </button>
        {isCustomAvatar(b.avatar) && (
          <button type="button" className="bot-editor-hero-change" title="更换头像" onClick={pickAvatar}>
            更换
          </button>
        )}
      </div>

      <label>名字</label>
      <input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="TA 的名字，如：小柔" />

      <label>性格设定（说话方式 / 身份背景 / 你们的关系）</label>
      <textarea
        value={b.persona}
        rows={6}
        onChange={(e) => setB({ ...b, persona: e.target.value })}
        placeholder={'越具体越有味道，可以写：\n· 身份背景：五百年道行的九尾狐妖 / 来自赛博未来的机械少女\n· 说话方式：口癖、语气，如喜欢用「呀」结尾、爱讲冷笑话、古风夹现代\n· 性格标签：傲娇 / 毒舌护短 / 元气中二 / 温柔治愈\n· 擅长与爱好：写代码、讲睡前故事、聊星座塔罗\n· 你们的关系：损友 / 管家 / 学姐 / 冤家'}
      />

      <label>大脑（模型）</label>
      <div className="model-picker" style={{ gap: 8 }}>
        <select
          value={b.target.providerId}
          onChange={(e) => {
            const p = settings?.providers.find((x) => x.id === e.target.value)
            if (p) setB({ ...b, target: { providerId: p.id, model: p.models[0] ?? '' } })
          }}
        >
          {availableProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {!availableProviders.find((p) => p.id === b.target.providerId) && (
            <option value={b.target.providerId}>{provider?.name ?? b.target.providerId}（未配置）</option>
          )}
        </select>
        <select
          value={b.target.model}
          onChange={(e) => setB({ ...b, target: { ...b.target, model: e.target.value } })}
        >
          {(provider?.models ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="row-end">
        <button className="btn" onClick={onDone}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={!b.name.trim() || !b.persona.trim()}
          onClick={async () => {
            await api.bots.upsert({ ...b, name: b.name.trim(), persona: b.persona.trim() })
            onDone()
          }}
        >
          {bot.name ? '保存' : '创建'}
        </button>
      </div>

      {viewingAvatar && isCustomAvatar(b.avatar) && (
        <div className="avatar-lightbox" onClick={() => setViewingAvatar(false)} title="点击任意处关闭">
          <img src={customAvatarUrl(b.avatar)} alt={b.name} />
          <p>点击任意处关闭 · 头像右下角「更换」可换新图</p>
        </div>
      )}
      {cropSrc && (
        <AvatarCropper
          src={cropSrc}
          onCancel={() => setCropSrc(null)}
          onOk={async (dataUrl) => {
            setCropSrc(null)
            try {
              const rel = await api.avatars.saveData(dataUrl)
              setB({ ...b, avatar: rel })
            } catch (e) {
              alert('保存头像失败：' + String(e instanceof Error ? e.message : e))
            }
          }}
        />
      )}
    </div>
  )
}

// ---------- 单聊（Grok 伙伴式：角色头部 + 沉浸对话） ----------

function BotChat({ bot, onEdit }: { bot: Bot | null; onEdit: (b: Bot) => void }) {
  const [messages, setMessages] = useState<BotMsg[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [memoryCount, setMemoryCount] = useState(0)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (bot) {
      api.bots.getMessages(bot.id).then(setMessages)
      api.bots.getMemory(bot.id).then((m: any) => setMemoryCount(m.facts?.length ?? 0))
    } else setMessages([])
    setStreamText('')
    setError('')
    // 切换机器人时解锁输入：上一个机器人的流仍在后台跑，靠事件过滤互不干扰
    setStreaming(false)
    // 但如果这个机器人本身还在回（切页回来），要把「输入中」状态补回来
    if (bot) {
      api.bots
        .active()
        .then((ids: string[]) => {
          if (ids.includes(bot.id)) setStreaming(true)
        })
        .catch(() => {})
    }
  }, [bot?.id])

  useEffect(() => {
    const off = api.bots.onEvent((e: any) => {
      // 只处理当前机器人的事件——别的机器人的流式回复不许灌进来
      if (e.botId && e.botId !== bot?.id) return
      switch (e.type) {
        case 'user-saved':
          setMessages((m) => [...m, { id: 'tmp' + Date.now(), sender: 'user', content: e.content, ts: Date.now() }])
          break
        case 'delta':
          setStreamText((t) => t + e.text)
          break
        case 'done':
          setMessages((m) => [
            ...m,
            {
              id: 'tmp' + Date.now(),
              sender: 'bot',
              content: e.content ?? streamRef.current,
              images: (e.images as string[] | undefined)?.length ? e.images : undefined,
              video: e.video,
              audio: e.audio,
              ts: Date.now()
            }
          ])
          setStreamText('')
          api.bots.getMemory(bot!.id).then((m: any) => setMemoryCount(m.facts?.length ?? 0))
          break
        case 'error':
          if (e.message !== '__aborted__') setError(e.message)
          break
        case 'memory-updated':
          // 即时记忆是异步提炼的，往往在 done 之后才落盘，这里补一次刷新
          setMemoryCount(typeof e.count === 'number' ? e.count : 0)
          break
        case 'end':
          sendingRef.current = false
          setStreaming(false)
          break
      }
    })
    return off
  }, [bot?.id])

  const streamRef = useRef('')
  streamRef.current = streamText

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamText])

  if (!bot) return null

  // streaming 是异步 state，连点时来不及拦住 → 用 ref 同步闸门（同聊天页的连点问题）
  const sendingRef = useRef(false)
  const send = () => {
    const text = input.trim()
    if (!text || streaming || sendingRef.current) return
    sendingRef.current = true
    setInput('')
    setError('')
    setStreaming(true)
    setStreamText('')
    api.bots.send({ botId: bot.id, userText: text })
  }

  return (
    <>
      <div className="bot-chat-head">
        <Avatar bot={bot} size={46} />
        <div className="bot-chat-head-info">
          <div className="bot-chat-head-name">{bot.name}</div>
          <div className="bot-chat-head-tag">
            {tagline(bot.persona)} · 记住了 {memoryCount} 件关于你的事
          </div>
        </div>
        <button className="btn sm bot-chat-edit" onClick={() => onEdit(bot)}>
          设定
        </button>
      </div>

      <div className="messages">
        {messages.length === 0 && !streaming && (
          <div className="empty-hint bot-empty">
            {bot.avatar && <Avatar bot={bot} size={96} />}
            <p className="bot-empty-name">
              {bot.name}
              {bot.preset && <span className="preset-badge" title="官方拟人形象">✦</span>}
            </p>
            <p>
              和 {bot.name} 打个招呼吧，<br />
              TA 会一直记得你说的每件事。
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.sender === 'user' ? 'msg user' : 'msg assistant bot-msg'}>
            {m.sender === 'bot' && <Avatar bot={bot} size={30} />}
            <div className="msg-body">
              {m.images?.length ? (
                <div className="msg-images">
                  {m.images.map((n) => (
                    <img key={n} src={`xjfile://img/${encodeURIComponent(n)}`} alt="" />
                  ))}
                </div>
              ) : null}
              {m.video ? (
                <video className="gen-video" src={`xjfile://video/${encodeURIComponent(m.video)}`} controls preload="metadata" />
              ) : null}
              {m.audio ? (
                <audio className="gen-audio" src={`xjfile://audio/${encodeURIComponent(m.audio)}`} controls preload="metadata" />
              ) : null}
              {m.content}
            </div>
          </div>
        ))}
        {streamText && (
          <div className="msg assistant bot-msg">
            <Avatar bot={bot} size={30} />
            <div className="msg-body">{streamText}</div>
          </div>
        )}
        {error && <div className="error-box">⚠ {error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          placeholder={`和 ${bot.name} 聊聊…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
        />
        <div className="composer-bottom">
          <span className="dim" style={{ fontSize: 12 }}>
            💭 长期记忆 · 越聊越懂你
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            {streaming ? (
              <button className="send-btn stop" onClick={() => api.bots.stop(bot.id)} title="停止">
                ■
              </button>
            ) : (
              <button className="send-btn" onClick={send} disabled={!input.trim()} title="发送">
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ---------- 建群 ----------

function GroupNew({ bots, onDone }: { bots: Bot[]; onDone: (created?: Group) => void }) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  return (
    <div className="bot-editor">
      <h3 style={{ fontSize: 17, fontWeight: 600 }}>新建群聊</h3>
      <label>群名</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：周末茶话会" />
      <label>拉谁进群（可多选）</label>
      <div className="group-pick">
        {bots.map((b) => (
          <button
            key={b.id}
            type="button"
            className={'group-pick-item' + (selected.includes(b.id) ? ' sel' : '')}
            onClick={() =>
              setSelected((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]))
            }
          >
            <Avatar bot={b} size={34} />
            <span>{b.name}</span>
          </button>
        ))}
      </div>
      <p className="dim" style={{ fontSize: 12 }}>
        群里 @名字 指定某人回答；不 @ 则大家轮流发言。
      </p>
      <div className="row-end">
        <button className="btn" onClick={() => onDone()}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={!name.trim() || selected.length < 1}
          onClick={async () => {
            const g = await api.groups.create(name.trim(), selected)
            onDone(g)
          }}
        >
          建群
        </button>
      </div>
    </div>
  )
}

// ---------- 群聊 ----------

function GroupChat({ group, bots }: { group: Group | null; bots: Bot[] }) {
  const [messages, setMessages] = useState<BotMsg[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamBuf, setStreamBuf] = useState<{ botId: string; text: string } | null>(null)
  const [typingName, setTypingName] = useState('')
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (group) api.groups.getMessages(group.id).then(setMessages)
    else setMessages([])
    setStreamBuf(null)
    setError('')
    setStreaming(false)
    setTypingName('')
    // 切页回来时这个群可能还在轮流发言，把状态补回来
    if (group) {
      api.bots
        .active()
        .then((ids: string[]) => {
          if (ids.includes(group.id)) setStreaming(true)
        })
        .catch(() => {})
    }
  }, [group?.id])

  useEffect(() => {
    const off = api.groups.onEvent((e: any) => {
      // 只处理当前群的事件——别的群（或单聊）的流不灌进来
      if (e.groupId && e.groupId !== group?.id) return
      switch (e.type) {
        case 'user-saved':
          setMessages((m) => [...m, { id: 'tmp' + Date.now(), sender: 'user', content: e.content, ts: Date.now() }])
          break
        case 'bot-typing':
          setTypingName(e.botName)
          break
        case 'delta':
          setStreamBuf((s) =>
            s && s.botId === e.botId ? { botId: e.botId, text: s.text + e.text } : { botId: e.botId, text: e.text }
          )
          break
        case 'done':
          if (e.content ?? streamRef.current) {
            setMessages((m) => [
              ...m,
              { id: 'tmp' + Date.now(), sender: 'bot', botId: e.botId, content: e.content ?? streamRef.current, ts: Date.now() }
            ])
          }
          setStreamBuf(null)
          setTypingName('')
          break
        case 'error':
          if (e.message !== '__aborted__') setError(e.message)
          break
        case 'end':
          sendingRef.current = false
          setStreaming(false)
          setTypingName('')
          break
      }
    })
    return off
  }, [group?.id])

  const streamRef = useRef('')
  useEffect(() => {
    streamRef.current = streamBuf?.text ?? ''
  }, [streamBuf])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamBuf])

  if (!group) return null

  const sendingRef = useRef(false)
  const send = () => {
    const text = input.trim()
    if (!text || streaming || sendingRef.current) return
    sendingRef.current = true
    setInput('')
    setError('')
    setStreaming(true)
    setStreamBuf(null)
    api.groups.send({ groupId: group.id, userText: text })
  }

  const botOf = (id?: string) => bots.find((b) => b.id === id)
  const memberBots = bots.filter((b) => group.botIds.includes(b.id))

  return (
    <>
      <div className="group-chat-head">
        <div className="group-avatars">
          {memberBots.slice(0, 4).map((b) => (
            <Avatar key={b.id} bot={b} size={28} />
          ))}
        </div>
        <div className="bot-chat-head-info">
          <div className="bot-chat-head-name">{group.name}</div>
          <div className="bot-chat-head-tag">{memberBots.map((b) => b.name).join('、')}</div>
        </div>
      </div>

      <div className="messages">
        {messages.map((m) => {
          const b = botOf(m.botId)
          return (
            <div key={m.id} className={m.sender === 'user' ? 'msg user' : 'msg assistant bot-msg'}>
              {m.sender === 'bot' && b && <Avatar bot={b} size={30} />}
              <div className="msg-body">
                {m.sender === 'bot' && <div className="bot-name">{b?.name}</div>}
                {m.content}
              </div>
            </div>
          )
        })}
        {streamBuf && botOf(streamBuf.botId) && (
          <div className="msg assistant bot-msg">
            <Avatar bot={botOf(streamBuf.botId)!} size={30} />
            <div className="msg-body">
              <div className="bot-name">{botOf(streamBuf.botId)?.name}</div>
              {streamBuf.text}
            </div>
          </div>
        )}
        {typingName && !streamBuf && <div className="status-line">{typingName} 正在输入…</div>}
        {error && <div className="error-box">⚠ {error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          placeholder={`@${memberBots[0]?.name ?? '名字'} 指定回答，不 @ 则轮流`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
        />
        <div className="composer-bottom">
          <span className="dim" style={{ fontSize: 12 }}>
            @名字 指定回答 · 不 @ 则轮流发言
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            {streaming ? (
              <button className="send-btn stop" onClick={() => group && api.groups.stop(group.id)} title="停止">
                ■
              </button>
            ) : (
              <button className="send-btn" onClick={send} disabled={!input.trim()} title="发送">
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
