import { useCallback, useEffect, useState } from 'react'
import { api, AppSettings, ProviderConfig, DataStats, FederationSettings, FedRoleConfig, GenModelInfo } from '../api'
import { markStatus, testProvider, useProvStatus } from '../providerStatus'
import { Gear, Trash, ImageIcon, FilmIcon, MusicIcon } from './Icons'
import ConfirmDialog from './ConfirmDialog'
import PromptDialog from './PromptDialog'

type SectionKey = 'models' | 'skin' | 'federation' | 'gen' | 'memory' | 'storage' | 'ollama' | 'privacy'

const SECTIONS: { key: SectionKey; label: string; desc: string }[] = [
  { key: 'models', label: '模型', desc: '接入云端模型供应商，或使用本地 Ollama' },
  { key: 'skin', label: '皮肤', desc: '十套配色皮肤；用户消息与 AI 回答分色显示' },
  { key: 'federation', label: '联合', desc: '主模型调度辅助模型：委派子任务、识图、上下文压缩；本地生图/生视频/生音乐能力在此查看' },
  { key: 'gen', label: '生图视频', desc: '本地 ComfyUI 生成图片与视频：服务状态、模型管理' },
  { key: 'memory', label: '记忆', desc: '会话记忆自动压缩与全局偏好学习' },
  { key: 'storage', label: '数据', desc: '所有本地数据的存放位置、导出与删除' },
  { key: 'ollama', label: '本地模型', desc: 'Ollama 安装、运行与模型管理' },
  { key: 'privacy', label: '隐私', desc: '小镜的隐私总纲' }
]

/** 皮肤清单（与 styles.css 的 data-skin 一一对应） */
const SKINS: { id: string; name: string; bg: string; accent: string }[] = [
  { id: 'light', name: '净白', bg: '#ffffff', accent: '#10a37f' },
  { id: 'dark', name: '墨黑', bg: '#212121', accent: '#10a37f' },
  { id: 'orange-light', name: '暖橙', bg: '#fffdfb', accent: '#e8590c' },
  { id: 'orange-dark', name: '落日', bg: '#251c15', accent: '#f76707' },
  { id: 'green-light', name: '青竹', bg: '#fbfdfb', accent: '#2f9e44' },
  { id: 'green-dark', name: '森林', bg: '#1a211b', accent: '#37b24d' },
  { id: 'purple-light', name: '紫罗兰', bg: '#fcfbfe', accent: '#7048e8' },
  { id: 'purple-dark', name: '暗夜紫', bg: '#201b28', accent: '#845ef7' },
  { id: 'blue-light', name: '海蓝', bg: '#f9fbfe', accent: '#1971c2' },
  { id: 'blue-dark', name: '深海蓝', bg: '#161c24', accent: '#339af0' },
  // 第二批 20 套
  { id: 'sakura-light', name: '樱粉', bg: '#fffbfc', accent: '#d6336c' },
  { id: 'mint-light', name: '薄荷', bg: '#f7fdfa', accent: '#0ca678' },
  { id: 'lemon-light', name: '柠黄', bg: '#fffef7', accent: '#e8950c' },
  { id: 'peach-light', name: '蜜桃', bg: '#fffaf7', accent: '#e4593b' },
  { id: 'cyan-light', name: '天青', bg: '#f7fcfd', accent: '#0b7285' },
  { id: 'orchid-light', name: '藕荷', bg: '#fcfafd', accent: '#9c36b5' },
  { id: 'lime-light', name: '青柠', bg: '#fbfdf4', accent: '#66a80f' },
  { id: 'teal-light', name: '湖绿', bg: '#f7fcfc', accent: '#0c8599' },
  { id: 'sand-light', name: '沙漠', bg: '#fdfaf3', accent: '#a8794a' },
  { id: 'steel-light', name: '雾蓝', bg: '#f9fafc', accent: '#4c6ef5' },
  { id: 'graphite-dark', name: '石墨', bg: '#1c1c1e', accent: '#ced4da' },
  { id: 'coffee-dark', name: '咖啡', bg: '#221b14', accent: '#d29a55' },
  { id: 'wine-dark', name: '酒红', bg: '#201315', accent: '#e03131' },
  { id: 'amber-dark', name: '琥珀', bg: '#1f1a0f', accent: '#e8a33d' },
  { id: 'matcha-dark', name: '抹茶', bg: '#181d13', accent: '#8db532' },
  { id: 'indigo-dark', name: '靛蓝', bg: '#151722', accent: '#5c7cfa' },
  { id: 'rose-dark', name: '玫瑰', bg: '#1f1418', accent: '#f06595' },
  { id: 'tundra-dark', name: '苔原', bg: '#131b1c', accent: '#22b8cf' },
  { id: 'slate-dark', name: '岩黑', bg: '#17191d', accent: '#38d9a9' },
  { id: 'plum-dark', name: '梅子', bg: '#1c141f', accent: '#da77f2' }
]

/** 联合角色元数据（与主进程 federation.ts 保持一致） */
const FED_ROLE_META: { key: keyof Omit<FederationSettings, 'enabled'>; icon: string; label: string; desc: string; placeholder: string }[] = [
  {
    key: 'subAgent',
    icon: '🧠',
    label: '辅助代理',
    desc: '接收主模型委派的简单子任务（改写、翻译、总结、资料整理等），主模型负责规划与验收',
    placeholder: '由主模型兼任（不委派）'
  },
  {
    key: 'vision',
    icon: '👁',
    label: '识图',
    desc: '聊天发送图片时，先由识图模型把图片转成详细文字描述再交给主模型；主模型自己能看图则无需配置',
    placeholder: '主模型自己看图'
  },
  {
    key: 'compress',
    icon: '📦',
    label: '上下文压缩',
    desc: '聊天与 Codex 的记忆压缩交给更快更便宜的模型完成，省时省钱',
    placeholder: '由主模型兼任'
  },
  {
    key: 'imageGen',
    icon: '🎨',
    label: '生图',
    desc: '本地 ComfyUI 生图模型就绪时优先本地（Z-Image / FLUX.3 / SDXL，聊天里直接说「画一张…」就会调用，无需配置）；下方云端厂商作为本地不可用时的后备（走 /images/generations 接口，如 GLM cogview）',
    placeholder: '不配置云端（仅本地生图）'
  },
  {
    key: 'videoGen',
    icon: '🎬',
    label: '生视频',
    desc: '本地 ComfyUI 生视频模型就绪时直接可用（LTX-Video / MiniMax H3，聊天里说「生成一段视频…」即触发）；云端厂商暂无统一生视频接口，以下仅作占位预留',
    placeholder: '云端预留（暂无接口）'
  }
]

interface AddDraft {
  vendorId: string
  name: string
  baseUrl: string
  apiKey: string
}

export default function Settings({
  settings,
  onClose,
  onSaved
}: {
  settings: AppSettings | null
  onClose: () => void
  onSaved: (s: AppSettings) => void
}) {
  const [s, setS] = useState<AppSettings | null>(settings)
  const [section, setSection] = useState<SectionKey>('models')
  const [notice, setNotice] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [ollama, setOllama] = useState<{ running: boolean; models: { name: string; size: number }[] } | null>(null)
  const [pullModel, setPullModel] = useState('')
  const [pullStatus, setPullStatus] = useState('')
  const [delProv, setDelProv] = useState<ProviderConfig | null>(null)
  const [delModel, setDelModel] = useState<string | null>(null)
  const [keyPrompt, setKeyPrompt] = useState<{ providerId: string; name: string } | null>(null)
  const [pullingId, setPullingId] = useState<string | null>(null) // 正在拉取模型的厂商
  const provStatus = useProvStatus()

  useEffect(() => {
    if (settings) setS(settings)
  }, [settings])

  const refreshOllama = useCallback(() => {
    api.ollama.status().then(setOllama)
  }, [])
  useEffect(refreshOllama, [refreshOllama])

  // 本地模型列表自动同步进 Ollama 供应商配置（模型选择器因此始终拿到最新列表）
  useEffect(() => {
    if (!ollama?.running) return
    const names = ollama.models.map((m) => m.name)
    void (async () => {
      const cur: AppSettings = await api.settings.get()
      const p = cur.providers.find((x) => x.id === 'ollama')
      if (!p) return
      const same = p.models.length === names.length && p.models.every((m, i) => m === names[i])
      if (same) return
      const fresh = await api.settings.set({
        ...cur,
        providers: cur.providers.map((x) => (x.id === 'ollama' ? { ...x, models: names } : x))
      })
      setS(fresh)
      onSaved(fresh)
    })()
  }, [ollama])

  useEffect(() => {
    const off = api.ollama.onPullEvent((e: any) => {
      if (e.error) setPullStatus('❌ ' + e.error)
      else if (e.done) setPullStatus('✅ 完成')
      else if (e.percent !== undefined) setPullStatus(`${e.status} ${e.percent}%`)
      else if (e.status) setPullStatus(e.status)
    })
    return off
  }, [])

  if (!s) return null

  const configured = s.providers.filter((p) => p.hasKey)
  const meta = SECTIONS.find((x) => x.key === section)!

  // 默认模型只列「可用的」：云厂商需已接入且未被判定连接失败；Ollama 需在运行且有模型
  const ollamaUsable = !!(ollama?.running && ollama.models.length > 0)
  const defaultChoices = [
    ...s.providers.filter((p) => p.hasKey && provStatus[p.id]?.ok !== false),
    ...(ollamaUsable ? s.providers.filter((p) => p.id === 'ollama') : [])
  ]

  const patchProvider = (id: string, patch: Partial<ProviderConfig>) => {
    setS({
      ...s,
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    })
  }

  const save = async () => {
    if (!s) return
    const saved = await api.settings.set(s)
    onSaved(saved)
    setNotice('已保存')
    setTimeout(() => setNotice(''), 1800)
  }

  const removeProvider = async (id: string) => {
    await api.settings.setProviderKey(id, '')
    const fresh = await api.settings.get()
    setS(fresh)
    onSaved(fresh)
  }

  const addProvider = async (d: AddDraft) => {
    let id = d.vendorId
    if (d.vendorId === 'custom') {
      id = 'custom_' + Date.now().toString(36)
      await api.settings.set({
        ...s!,
        providers: [
          ...s!.providers,
          {
            id,
            name: d.name || '自定义',
            baseUrl: d.baseUrl,
            apiType: 'openai',
            hasKey: false,
            models: []
          } as ProviderConfig
        ]
      })
    }
    if (d.apiKey) await api.settings.setProviderKey(id, d.apiKey)
    // 接入后自动拉取该厂商的真实模型列表；拉不到就用内置默认，无需手动填模型名
    let models: string[] = []
    let fetchErr: string | undefined
    try {
      models = await api.models.list(id)
    } catch (e) {
      fetchErr = e instanceof Error ? e.message : String(e)
    }
    markStatus(id, models.length > 0, models.length ? undefined : fetchErr ?? '未获取到模型列表')
    let fresh: AppSettings = await api.settings.get()
    if (models.length) {
      fresh = await api.settings.set({
        ...fresh,
        providers: fresh.providers.map((p) => (p.id === id ? { ...p, models } : p))
      })
    }
    // 首次接入且还没有默认模型时，直接用新厂商的第一个模型
    if (!fresh.defaultProviderId) {
      const p = fresh.providers.find((x) => x.id === id)
      if (p?.models.length) {
        fresh = await api.settings.set({ ...fresh, defaultProviderId: p.id, defaultModel: p.models[0] })
      }
    }
    setS(fresh)
    onSaved(fresh)
    setAddOpen(false)
  }

  return (
    <div className="settings-layout">
      {/* 左：分类导航 */}
      <aside className="set-nav">
        <div className="set-nav-title">
          <Gear size={15} />
          <span>设置</span>
          <span className="spacer" />
          <button className="btn ghost sm set-back" onClick={onClose}>
            返回
          </button>
        </div>
        <div className="set-nav-list">
          {SECTIONS.map((x) => (
            <button
              key={x.key}
              type="button"
              className={'set-nav-item' + (section === x.key ? ' active' : '')}
              onClick={() => setSection(x.key)}
            >
              {x.label}
            </button>
          ))}
        </div>
      </aside>

      {/* 右：内容区 */}
      <section className="set-content">
        <div className="set-content-head">
          <h2>{meta.label}</h2>
          <div className="set-head-right">
            {notice && <span className="set-notice">{notice}</span>}
            <button className="btn primary sm" onClick={save}>
              保存
            </button>
          </div>
        </div>

        {section === 'models' && (
          <div className="set-body">
            {configured.length === 0 ? (
              <button className="set-add-banner" onClick={() => setAddOpen(true)}>
                <span className="set-add-plus">＋</span>
                <div>
                  <div className="set-add-title">接入你的第一个模型</div>
                  <div className="set-add-sub">选厂商 → 填 API Key → 立即可用；也可以用本地 Ollama</div>
                </div>
              </button>
            ) : (
              <>
                <button className="set-add-inline" onClick={() => setAddOpen(true)}>
                  ＋ 添加模型
                </button>
                {configured.map((p) => {
                  const st = provStatus[p.id]
                  const dot = !p.hasKey ? 'off' : st?.testing ? 'off' : st ? (st.ok ? 'ok' : 'fail') : 'off'
                  const label = !p.hasKey
                    ? '未接入'
                    : st?.testing
                      ? '检测中…'
                      : st
                        ? st.ok
                          ? '已连接'
                          : '连接失败'
                        : '待检测'
                  return (
                  <div key={p.id} className="provider-card">
                    <div className="provider-row">
                      <span
                        className={'set-provider-dot ' + dot}
                        title={st?.err ?? (dot === 'ok' ? '连接正常' : '')}
                      />
                      <strong>{p.name}</strong>
                      <span className={'prov-status ' + (dot === 'fail' ? 'fail' : dot === 'ok' ? 'ok' : '')}>
                        {label}
                      </span>
                      <span className="spacer" />
                      <button
                        className="btn ghost sm"
                        onClick={() => testProvider(p.id)}
                        title="测试 API 连接"
                      >
                        测试
                      </button>
                      <button
                        className="btn ghost sm"
                        onClick={() => setKeyPrompt({ providerId: p.id, name: p.name })}
                      >
                        改密钥
                      </button>
                      <button
                        className="btn ghost sm"
                        disabled={pullingId === p.id}
                        onClick={async () => {
                          setPullingId(p.id)
                          try {
                            const list = await api.models.list(p.id)
                            if (list.length) {
                              patchProvider(p.id, { models: list })
                              markStatus(p.id, true)
                              setNotice(`已拉取 ${list.length} 个模型`)
                              setTimeout(() => setNotice(''), 2500)
                            } else {
                              markStatus(p.id, false, '未获取到模型')
                              alert('未获取到模型')
                            }
                          } catch (e) {
                            markStatus(p.id, false, e instanceof Error ? e.message : String(e))
                            alert(String(e instanceof Error ? e.message : e))
                          } finally {
                            setPullingId(null)
                          }
                        }}
                      >
                        {pullingId === p.id ? '拉取中…' : '拉取模型'}
                      </button>
                      <button className="btn danger ghost sm" onClick={() => setDelProv(p)}>
                        删除
                      </button>
                    </div>
                    <div className="provider-row">
                      <label className="set-field-label">API 地址</label>
                      <input
                        className="grow"
                        value={p.baseUrl}
                        onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                      />
                    </div>
                    <div className="provider-row">
                      <label className="set-field-label">模型</label>
                      <input
                        className="grow"
                        value={p.models.join(', ')}
                        placeholder="逗号分隔，如 glm-4.6, glm-4.5-air"
                        onChange={(e) =>
                          patchProvider(p.id, {
                            models: e.target.value.split(',').map((x) => x.trim()).filter(Boolean)
                          })
                        }
                      />
                    </div>
                  </div>
                  )
                })}
              </>
            )}

            {/* 本地 Ollama 卡片（与云厂商同款样式，有无云厂商都显示） */}
            {s.providers
              .filter((p) => p.id === 'ollama')
              .map((p) => {
                const running = !!ollama?.running
                const count = ollama?.models.length ?? 0
                return (
                  <div key={p.id} className="provider-card">
                    <div className="provider-row">
                      <span className={'set-provider-dot ' + (running ? 'ok' : 'off')} title={running ? '服务运行中' : '服务未运行'} />
                      <strong>{p.name}</strong>
                      <span className={'prov-status ' + (running ? 'ok' : '')}>
                        {running ? `运行中 · ${count} 个模型` : '未运行'}
                      </span>
                      <span className="spacer" />
                      {!running && (
                        <button
                          className="btn ghost sm"
                          onClick={async () => {
                            const ok = await api.ollama.start(s.ollamaDir)
                            refreshOllama()
                            if (!ok) alert('启动失败，请确认已安装 Ollama（可在「本地模型」中安装）')
                          }}
                        >
                          启动
                        </button>
                      )}
                      <button className="btn ghost sm" onClick={refreshOllama} title="重新检测服务与模型">
                        刷新
                      </button>
                      <button className="btn ghost sm" onClick={() => setSection('ollama')} title="安装 / 拉取 / 删除模型">
                        管理
                      </button>
                    </div>
                    <div className="provider-row">
                      <label className="set-field-label">API 地址</label>
                      <input
                        className="grow"
                        value={p.baseUrl}
                        onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                      />
                    </div>
                    <div className="provider-row">
                      <label className="set-field-label">模型</label>
                      <span className="grow ollama-models">
                        {running && count ? p.models.join(', ') : '（启动后自动同步本地模型列表，到「管理」里拉取新模型）'}
                      </span>
                    </div>
                  </div>
                )
              })}

            <div className="set-subblock">
              <div className="set-subblock-title">默认模型</div>
              <div className="provider-row">
                <select
                  value={s.defaultProviderId}
                  onChange={(e) => {
                    const p = s.providers.find((x) => x.id === e.target.value)
                    if (p) setS({ ...s, defaultProviderId: p.id, defaultModel: p.models[0] ?? '' })
                  }}
                >
                  <option value="">请选择</option>
                  {defaultChoices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select value={s.defaultModel} onChange={(e) => setS({ ...s, defaultModel: e.target.value })}>
                  {(s.providers.find((p) => p.id === s.defaultProviderId)?.models ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {section === 'skin' && (
          <div className="set-body wide">
            <div className="skin-grid">
              {SKINS.map((k) => {
                const cur = (s.skin ?? 'light') === k.id
                return (
                  <button
                    key={k.id}
                    type="button"
                    className={'skin-card' + (cur ? ' sel' : '')}
                    onClick={() => {
                      setS({ ...s, skin: k.id })
                      document.documentElement.setAttribute('data-skin', k.id)
                    }}
                  >
                    {/* 迷你聊天界面预览：data-skin 让 CSS 变量在卡片内级联，看到的就是实际效果 */}
                    <span className="skin-preview skin-chat" data-skin={k.id}>
                      <span className="skin-chat-side" />
                      <span className="skin-chat-main">
                        <span className="skin-chat-msg user">帮我写一句诗</span>
                        <span className="skin-chat-msg ai">
                          落霞与孤鹜齐飞，秋水共长天一色。
                        </span>
                        <span className="skin-chat-input">
                          <span className="skin-chat-input-txt" />
                          <span className="skin-chat-send" />
                        </span>
                      </span>
                    </span>
                    <span className="skin-name">{k.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {section === 'federation' && (
          <div className="set-body">
            <FedPanel s={s} setS={setS} provStatus={provStatus} ollamaUsable={ollamaUsable} />
          </div>
        )}

        {section === 'gen' && (
          <div className="set-body">
            <GenPanel s={s} setS={setS} />
          </div>
        )}

        {section === 'memory' && (
          <div className="set-body">
            <div className="set-subblock-title">上下文预算（分场景独立可调）</div>
            {([
              { key: 'chatTokens', label: '聊天预算', hint: '新聊天会话的默认预算' },
              { key: 'codexTokens', label: 'Codex 预算', hint: '新 Codex 任务的默认预算' },
              { key: 'botsTokens', label: '机器人预算', hint: '机器人单聊的注入窗口预算' }
            ] as const).map((row) => (
              <div key={row.key} className="provider-row" style={{ marginTop: 10 }}>
                <select
                  className="set-num"
                  value={s[row.key] ?? s.memoryTokens ?? 32768}
                  onChange={(e) => setS({ ...s, [row.key]: Number(e.target.value) })}
                  title={row.hint}
                >
                  <option value={16384}>16K</option>
                  <option value={32768}>32K</option>
                  <option value={65536}>64K</option>
                  <option value={131072}>128K</option>
                  <option value={262144}>256K</option>
                  <option value={1048576}>1M</option>
                </select>
                <span className="dim">{row.label} · tokens</span>
              </div>
            ))}
            <div className="set-subblock" style={{ marginTop: 18 }}>
              <div className="set-subblock-title">全局偏好</div>
            </div>
          </div>
        )}

        {section === 'storage' && (
          <div className="set-body">
            <div className="set-subblock-title">数据目录</div>
            <div className="set-dir-row">
              <DataDirField />
            </div>
            <DataOverview />
            <div className="set-danger-zone">
              <div className="set-subblock-title">危险操作</div>
              <div className="provider-row">
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      const r = await api.settings.exportData()
                      const skipped = r.skipped?.length ? `\n\n有 ${r.skipped.length} 个文件被占用已跳过：\n${r.skipped.slice(0, 5).join('\n')}` : ''
                      alert(`已导出 ${r.files} 个文件到：\n${r.dir}${skipped}`)
                    } catch (e) {
                      alert('导出失败：' + String(e instanceof Error ? e.message : e))
                    }
                  }}
                >
                  导出全部数据
                </button>
                <button
                  className="btn danger sm"
                  onClick={async () => {
                    if (!confirm('彻底删除所有聊天、记忆、机器人数据？此操作不可恢复！')) return
                    if (!confirm('再次确认：真的要删除全部数据吗？')) return
                    await api.settings.wipe()
                    alert('已清空')
                  }}
                >
                  彻底删除全部数据
                </button>
              </div>
            </div>
          </div>
        )}

        {section === 'ollama' && (
          <div className="set-body">
            <div className="set-status-row">
              <span className={ollama?.running ? 'set-dot on' : 'set-dot'} />
              <span>{ollama?.running ? `运行中 · ${ollama.models.length} 个模型` : '未运行'}</span>
              <span className="spacer" />
              <button className="btn ghost sm" onClick={refreshOllama}>
                刷新
              </button>
              {!ollama?.running && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    const ok = await api.ollama.start(s.ollamaDir)
                    refreshOllama()
                    if (!ok) alert('启动失败，请确认已安装 Ollama')
                  }}
                  title="拉起 Ollama 后台服务（重启电脑后用）"
                >
                  启动
                </button>
              )}
              <button
                className="btn sm"
                onClick={async () => {
                  const setup = await api.ollama.findSetup('E:\\ollama-data-tmp')
                  if (!setup) {
                    api.ollama.openDownloadPage()
                    alert('未找到安装包，已打开下载页。下载后将 OllamaSetup.exe 放到 E:\\ollama-data-tmp 再点安装。')
                    return
                  }
                  setPullStatus('正在安装到 ' + s.ollamaDir + ' …')
                  try {
                    await api.ollama.install(setup, s.ollamaDir, s.ollamaModelsDir)
                    setPullStatus('✅ 安装完成，正在启动…')
                    await api.ollama.start(s.ollamaDir)
                    refreshOllama()
                  } catch (e) {
                    setPullStatus('❌ ' + String(e instanceof Error ? e.message : e))
                  }
                }}
              >
                安装
              </button>
            </div>

            <div className="set-subblock">
              <div className="fed-toggle-row">
                <div className="fed-toggle-text">
                  <div className="set-subblock-title">启动时自动拉起本地服务</div>
                  <p className="dim" style={{ fontSize: 12, margin: '4px 0 0' }}>
                    Ollama 与 ComfyUI 没运行时在后台静默启动（只走本机，不联网），打开小镜就能直接聊、直接生成，不用先手动点启动。
                  </p>
                </div>
                <button
                  type="button"
                  className={'fed-switch' + (s.autoStartLocal !== false ? ' on' : '')}
                  role="switch"
                  aria-checked={s.autoStartLocal !== false}
                  title={s.autoStartLocal !== false ? '点击关闭' : '点击开启'}
                  onClick={() => setS({ ...s, autoStartLocal: !(s.autoStartLocal !== false) })}
                >
                  <span className="fed-switch-knob" />
                </button>
              </div>
              <div className="fed-toggle-row" style={{ marginTop: 14 }}>
                <div className="fed-toggle-text">
                  <div className="set-subblock-title">退出时一并关闭</div>
                  <p className="dim" style={{ fontSize: 12, margin: '4px 0 0' }}>
                    关掉小镜时把上面这两个服务一起关掉，不在后台留常驻进程。你自己手动开的 Ollama / ComfyUI 不会被影响。
                  </p>
                </div>
                <button
                  type="button"
                  className={'fed-switch' + (s.stopLocalOnQuit !== false ? ' on' : '')}
                  role="switch"
                  aria-checked={s.stopLocalOnQuit !== false}
                  title={s.stopLocalOnQuit !== false ? '点击关闭' : '点击开启'}
                  onClick={() => setS({ ...s, stopLocalOnQuit: !(s.stopLocalOnQuit !== false) })}
                >
                  <span className="fed-switch-knob" />
                </button>
              </div>
            </div>

            <div className="set-subblock">
              <div className="set-subblock-title">目录位置</div>
              <div className="set-dir-field">
                <label className="set-field-label">程序</label>
                <input value={s.ollamaDir} onChange={(e) => setS({ ...s, ollamaDir: e.target.value })} />
              </div>
              <div className="set-dir-field">
                <label className="set-field-label">数据与模型</label>
                <input value={s.ollamaModelsDir} onChange={(e) => setS({ ...s, ollamaModelsDir: e.target.value })} />
              </div>
            </div>

            {ollama?.running && (
              <div className="set-subblock">
                <div className="set-subblock-title">模型</div>
                <div className="provider-row">
                  <input
                    className="grow"
                    value={pullModel}
                    placeholder="模型名，如 qwen3:8b / glm4:9b"
                    onChange={(e) => setPullModel(e.target.value)}
                  />
                  <button
                    className="btn primary sm"
                    disabled={!pullModel.trim()}
                    onClick={() => api.ollama.pull(pullModel.trim())}
                  >
                    拉取
                  </button>
                </div>
                {pullStatus && <div className="set-field-hint">{pullStatus}</div>}
                <ul className="model-list">
                  {ollama.models.map((m) => (
                    <li key={m.name}>
                      <span className="set-model-name">{m.name}</span>
                      <span className="dim">({(m.size / 1e9).toFixed(1)} GB)</span>
                      <button
                        className="session-del"
                        title="删除模型"
                        onClick={() => setDelModel(m.name)}
                      >
                        <Trash />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {section === 'privacy' && (
          <div className="set-body">
            <ul className="set-privacy-list">
              <li>所有数据只存放在你指定的本地目录，不上传任何服务器</li>
              <li>零遥测：不埋点、不统计、不上报崩溃</li>
              <li>API 密钥用 Windows 系统级加密（DPAPI）存储，明文永不落盘</li>
              <li>网络白名单：只连接你配置的模型 API 与搜索服务</li>
              <li>数据为明文 JSON，随时可导出、可彻底删除</li>
              <li>本地模型推理全程不出电脑</li>
            </ul>
          </div>
        )}
      </section>

      {addOpen && s && (
        <AddModelDialog providers={s.providers} onCancel={() => setAddOpen(false)} onAdd={addProvider} />
      )}

      {delProv && (
        <ConfirmDialog
          title="移除服务商"
          message={`移除「${delProv.name}」及其密钥？相关会话仍保留，重新接入即可继续使用。`}
          onCancel={() => setDelProv(null)}
          onConfirm={async () => {
            await removeProvider(delProv.id)
            setDelProv(null)
          }}
        />
      )}

      {delModel && (
        <ConfirmDialog
          title="删除本地模型"
          message={`删除模型 ${delModel}？会从磁盘移除模型文件以释放空间。`}
          onCancel={() => setDelModel(null)}
          onConfirm={async () => {
            await api.ollama.deleteModel(delModel!)
            refreshOllama()
            setDelModel(null)
          }}
        />
      )}

      {keyPrompt && (
        <PromptDialog
          title={`更新 ${keyPrompt.name} 的 API Key`}
          placeholder="sk-…（留空则清除该密钥）"
          okLabel="保存"
          allowEmpty
          onCancel={() => setKeyPrompt(null)}
          onOk={async (v) => {
            const { providerId } = keyPrompt
            setKeyPrompt(null)
            await api.settings.setProviderKey(providerId, v)
            setS(await api.settings.get())
            if (v.trim()) testProvider(providerId)
          }}
        />
      )}
    </div>
  )
}

// ---------- 添加模型弹窗 ----------

function AddModelDialog({
  providers,
  onCancel,
  onAdd
}: {
  providers: ProviderConfig[]
  onCancel: () => void
  onAdd: (d: AddDraft) => void
}) {
  const unconfigured = providers.filter((p) => !p.hasKey && p.id !== 'ollama')
  const [vendorId, setVendorId] = useState(unconfigured[0]?.id ?? 'custom')
  const vendor = providers.find((p) => p.id === vendorId)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<AddDraft>({
    vendorId,
    name: '',
    baseUrl: '',
    apiKey: ''
  })

  useEffect(() => {
    if (vendorId === 'custom') {
      setDraft((d) => ({ ...d, vendorId, name: '', baseUrl: 'https://' }))
    } else if (vendor) {
      setDraft((d) => ({ ...d, vendorId, name: vendor.name, baseUrl: vendor.baseUrl }))
    }
  }, [vendorId])

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>添加模型</h3>
        <label>选择厂商</label>
        <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
          {unconfigured.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="custom">自定义（OpenAI 兼容接口）</option>
        </select>
        {vendorId === 'custom' && (
          <>
            <label>名称</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="如：我的中转站" />
          </>
        )}
        <label>API 地址</label>
        <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://example.com/v1" />
        <label>API Key</label>
        <input
          type="password"
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          placeholder="sk-…（系统加密存储）"
        />
        <div className="row-end">
          <button className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={
              busy ||
              !draft.apiKey.trim() ||
              (vendorId === 'custom' && (!draft.name.trim() || !draft.baseUrl.trim()))
            }
            onClick={async () => {
              setBusy(true)
              try {
                await onAdd(draft)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '接入中…' : '接入'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 联合模式 ----------

function FedPanel({
  s,
  setS,
  provStatus,
  ollamaUsable
}: {
  s: AppSettings
  setS: (v: AppSettings) => void
  provStatus: ReturnType<typeof useProvStatus>
  ollamaUsable: boolean
}) {
  const fed: FederationSettings = s.federation ?? { enabled: false }
  // 可选厂商：已接入且连接未失败；Ollama 运行中可用
  const available = s.providers.filter((p) => (p.hasKey && provStatus[p.id]?.ok !== false) || (p.id === 'ollama' && ollamaUsable))

  // 本地 ComfyUI 媒体模型就绪状态（生图 / 生视频 / 生音乐卡展示用）
  const [genModels, setGenModels] = useState<GenModelInfo[]>([])
  useEffect(() => {
    api.comfy.models().then(setGenModels).catch(() => {})
  }, [])
  const localOf = (kind: 'image' | 'video' | 'audio') => genModels.filter((m) => m.kind === kind && m.ready)
  const localText = (kind: 'image' | 'video' | 'audio') => {
    const list = localOf(kind)
    return list.length ? `${list.map((m) => m.name).join('、')} 已就绪` : '未就绪（模型文件不全）'
  }

  const patchFed = (patch: Partial<FederationSettings>) => setS({ ...s, federation: { ...fed, ...patch } })

  const patchRole = (key: keyof Omit<FederationSettings, 'enabled'>, patch: Partial<FedRoleConfig>) => {
    const cur = fed[key] ?? { providerId: '', model: '' }
    patchFed({ [key]: { ...cur, ...patch } } as Partial<FederationSettings>)
  }

  return (
    <>
      <div className="fed-toggle-row">
        <div className="fed-toggle-text">
          <div className="set-subblock-title">联合模式</div>
        </div>
        <button
          type="button"
          className={'fed-switch' + (fed.enabled ? ' on' : '')}
          role="switch"
          aria-checked={fed.enabled}
          title={fed.enabled ? '点击关闭' : '点击开启'}
          onClick={() => patchFed({ enabled: !fed.enabled })}
        >
          <span className="fed-switch-knob" />
        </button>
      </div>

      <div className={'fed-roles' + (fed.enabled ? '' : ' disabled')}>
        {FED_ROLE_META.map((meta) => {
          const role = fed[meta.key]
          const pid = role?.providerId ?? ''
          const provider = s.providers.find((p) => p.id === pid)
          return (
            <div key={meta.key} className="provider-card fed-role-card" title={meta.desc}>
              <div className="provider-row">
                <strong>
                  {meta.icon} {meta.label}
                  {meta.key === 'videoGen' &&
                    (localOf('video').length ? <span className="fed-badge">本地可用</span> : <span className="fed-badge">云端预留</span>)}
                </strong>
              </div>
              <div className="provider-row">
                <select
                  value={pid}
                  onChange={(e) => {
                    const id = e.target.value
                    if (!id) {
                      patchRole(meta.key, { providerId: '', model: '' })
                    } else {
                      const p = s.providers.find((x) => x.id === id)
                      patchRole(meta.key, { providerId: id, model: p?.models[0] ?? '' })
                    }
                  }}
                >
                  <option value="">{meta.placeholder}</option>
                  {available.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  value={role?.model ?? ''}
                  disabled={!pid}
                  onChange={(e) => patchRole(meta.key, { model: e.target.value })}
                >
                  {!pid && <option value="">—</option>}
                  {(provider?.models ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {pid && role?.model && !provider?.models.includes(role.model) && (
                    <option value={role.model}>{role.model}</option>
                  )}
                </select>
              </div>
              {(meta.key === 'imageGen' || meta.key === 'videoGen') && (
                <div className="provider-row">
                  <span className={'set-provider-dot' + (localOf(meta.key === 'imageGen' ? 'image' : 'video').length ? ' ok' : '')} />
                  <span className="prov-status">
                    本地 ComfyUI{meta.key === 'imageGen' ? '生图' : '生视频'}：{localText(meta.key === 'imageGen' ? 'image' : 'video')}
                  </span>
                </div>
              )}
            </div>
          )
        })}
        <div className="provider-card fed-role-card">
          <div className="provider-row">
            <strong>🎵 生音乐</strong>
          </div>
          <div className="provider-row">
            <span className={'set-provider-dot' + (localOf('audio').length ? ' ok' : '')} />
            <span className="prov-status">
              本地 ComfyUI 生音乐：{localText('audio')}
              {localOf('audio').length ? '（云端暂无生音乐接口）' : '（云端暂无生音乐接口）'}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------- 生图视频（ComfyUI） ----------

function GenPanel({ s, setS }: { s: AppSettings; setS: (v: AppSettings) => void }) {
  const [status, setStatus] = useState<{ running: boolean; version?: string } | null>(null)
  const [models, setModels] = useState<GenModelInfo[]>([])
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState('')

  const refresh = useCallback(() => {
    api.comfy.status().then(setStatus)
    api.comfy.models().then(setModels)
  }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 20000)
    return () => clearInterval(t)
  }, [refresh])

  const port = s.comfyPort ?? 8188

  return (
    <>
      <div className="set-status-row">
        <span className={status?.running ? 'set-dot on' : 'set-dot'} />
        <span>
          {status?.running
            ? `运行中${status.version ? ' · ' + status.version : ''}`
            : '未运行'}
        </span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={refresh}>
          刷新
        </button>
        {!status?.running && (
          <button
            className="btn sm"
            disabled={starting}
            onClick={async () => {
              setStarting(true)
              setNote('正在启动 ComfyUI（最长等待 2 分钟；若一直未就绪，可能是旧实例假死占用端口，结束 python.exe 后重试）…')
              try {
                await api.comfy.start()
                refresh()
                setNote('✅ 已启动')
              } catch (e) {
                setNote('❌ ' + String(e instanceof Error ? e.message : e))
              } finally {
                setStarting(false)
                setTimeout(() => setNote(''), 6000)
              }
            }}
          >
            {starting ? '启动中…' : '启动'}
          </button>
        )}
      </div>
      {note && <div className="set-field-hint">{note}</div>}

      <div className="set-subblock">
        <div className="set-subblock-title">ComfyUI 位置</div>
        <div className="set-dir-field">
          <label className="set-field-label">安装目录</label>
          <input
            value={s.comfyDir ?? 'E:\\ComfyUI'}
            placeholder="E:\ComfyUI（便携版根目录，含 run_nvidia_gpu.bat）"
            onChange={(e) => setS({ ...s, comfyDir: e.target.value })}
          />
        </div>
        <div className="set-dir-field">
          <label className="set-field-label">端口</label>
          <input
            className="set-num"
            value={port}
            onChange={(e) => setS({ ...s, comfyPort: Number(e.target.value) || 8188 })}
          />
        </div>
      </div>

      <div className="set-subblock">
        <div className="set-subblock-title">模型</div>
        {models.map((m) => (
          <div key={m.id} className="provider-row gen-model-row">
            <span className={m.ready ? 'set-provider-dot ok' : 'set-provider-dot off'} title={m.ready ? '文件齐全' : '缺文件'} />
            <strong className="gen-kind-icon">
              {m.kind === 'image' ? <ImageIcon /> : m.kind === 'audio' ? <MusicIcon /> : <FilmIcon />}
              {m.name}
            </strong>
            <span className="dim">{m.ready ? m.desc : `缺 ${m.missing.length} 个文件：${m.missing[0]}`}</span>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------- 数据总览（记忆分类可视化） ----------

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function DataOverview() {
  const [st, setSt] = useState<DataStats | null>(null)
  const load = useCallback(() => {
    api.data.stats().then(setSt).catch(() => {})
  }, [])
  useEffect(load, [load])
  if (!st) return null
  const maxSize = Math.max(...st.categories.map((c) => c.size), 1)
  return (
    <div className="set-subblock data-overview">
      <div className="set-overview-head">
        <div className="set-subblock-title">记忆数据总览</div>
        <span className="dim set-overview-total">共 {fmtSize(st.totalSize)} · {st.facts} 条记忆事实</span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={load}>
          刷新
        </button>
      </div>
      <div className="data-overview-grid">
        {st.categories.map((c) => (
          <div key={c.key} className="stat-card">
            <div className="stat-label">{c.label}</div>
            <div className="stat-size">{fmtSize(c.size)}</div>
            <div className="stat-detail">{c.detail}</div>
            <div className="stat-bar">
              <i style={{ width: `${Math.max((c.size / maxSize) * 100, c.size > 0 ? 2 : 0)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="set-overview-head" style={{ marginTop: 16 }}>
        <div className="set-subblock-title">最近 5 周对话活跃</div>
      </div>
      <Heatmap days={st.activity} />
    </div>
  )
}

/** GitHub 贡献图风格的活跃热力图：7 行（周几）× 5 列（周） */
function Heatmap({ days }: { days: number[] }) {
  const today = new Date()
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 34)
  const offset = (first.getDay() + 6) % 7 // 周一为第一行
  const cells: { key: string; count: number; title?: string }[] = []
  for (let i = 0; i < offset; i++) cells.push({ key: 'pad' + i, count: -1 })
  for (let i = 0; i < days.length; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days.length - 1 - i))
    cells.push({
      key: 'd' + i,
      count: days[i],
      title: `${d.getMonth() + 1}月${d.getDate()}日 · ${days[i]} 条`
    })
  }
  const level = (c: number) => (c <= 0 ? 0 : c <= 2 ? 1 : c <= 6 ? 2 : c <= 15 ? 3 : 4)
  return (
    <div className="heatmap">
      <div className="heatmap-grid">
        {cells.map((c) => (
          <span
            key={c.key}
            className={'hm-cell' + (c.count < 0 ? ' pad' : ' lv' + level(c.count))}
            title={c.title}
          />
        ))}
      </div>
      <div className="heatmap-legend">
        少
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={'hm-cell lv' + l} />
        ))}
        多
      </div>
    </div>
  )
}

function DataDirField() {
  const [dir, setDir] = useState('')
  useEffect(() => {
    api.appInfo().then((i: any) => setDir(i.dataDir))
  }, [])
  return (
    <>
      <input className="grow mono" value={dir} onChange={(e) => setDir(e.target.value)} />
      <button
        className="btn sm"
        onClick={async () => {
          const d = await api.settings.pickDir()
          if (d) setDir(d)
        }}
      >
        浏览…
      </button>
      <button
        className="btn primary sm"
        onClick={async () => {
          const real = await api.settings.setDataDir(dir)
          setDir(real)
          alert('数据目录已切换到: ' + real)
        }}
      >
        迁移
      </button>
    </>
  )
}
