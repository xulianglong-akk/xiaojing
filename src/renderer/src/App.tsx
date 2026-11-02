import { useEffect, useState } from 'react'
import Chat from './components/Chat'
import Codex from './components/Codex'
import Bots from './components/Bots'
import GenPage from './components/GenPage'
import Settings from './components/Settings'
import TitleBar from './components/TitleBar'
import { AppSettings } from './api'
import { Tab } from './components/ModeMenu'
import { isFresh, testProvider } from './providerStatus'

export default function App() {
  const [tab, setTab] = useState<Tab>('chat')
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    window.api.settings.get().then(setSettings)
  }, [showSettings])

  // 启动/打开应用时自动对所有已接入的供应商做一次连接检测
  useEffect(() => {
    if (!settings) return
    for (const p of settings.providers) {
      if (p.hasKey && !isFresh(p.id)) testProvider(p.id)
    }
  }, [settings])

  // 皮肤：应用到根节点（CSS 变量按 data-skin 切换）
  useEffect(() => {
    document.documentElement.setAttribute('data-skin', settings?.skin || 'light')
  }, [settings?.skin])

  const openSettings = (): void => setShowSettings(true)

  return (
    <div className="app">
      <TitleBar />
      <main className="content">
        {showSettings ? (
          <Settings settings={settings} onClose={() => setShowSettings(false)} onSaved={setSettings} />
        ) : tab === 'chat' ? (
          <Chat settings={settings} tab={tab} onTab={setTab} onSettings={openSettings} />
        ) : tab === 'codex' ? (
          <Codex settings={settings} tab={tab} onTab={setTab} onSettings={openSettings} />
        ) : tab === 'image' || tab === 'video' || tab === 'music' ? (
          <GenPage
            key={tab}
            settings={settings}
            kind={tab === 'music' ? 'audio' : tab}
            tab={tab}
            onTab={setTab}
            onSettings={openSettings}
          />
        ) : (
          <Bots settings={settings} tab={tab} onTab={setTab} onSettings={openSettings} />
        )}
      </main>
    </div>
  )
}
