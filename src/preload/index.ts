import { contextBridge, ipcRenderer } from 'electron'

const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),

  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    onState: (cb: (maxed: boolean) => void) => {
      const fn = (_: unknown, v: unknown) => cb(!!v)
      ipcRenderer.on('win:state', fn)
      return () => {
        ipcRenderer.removeListener('win:state', fn)
      }
    }
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s: unknown) => ipcRenderer.invoke('settings:set', s),
    setProviderKey: (providerId: string, key: string) => ipcRenderer.invoke('settings:setProviderKey', providerId, key),
    setSearchKey: (which: 'tavily' | 'bocha', key: string) => ipcRenderer.invoke('settings:setSearchKey', which, key),
    setDataDir: (dir: string) => ipcRenderer.invoke('settings:setDataDir', dir),
    exportData: () => ipcRenderer.invoke('settings:export'),
    wipe: () => ipcRenderer.invoke('settings:wipe'),
    pickDir: () => ipcRenderer.invoke('settings:pickDir'),
    pickWorkDir: () => ipcRenderer.invoke('settings:pickWorkDir')
  },

  models: {
    list: (providerId: string) => ipcRenderer.invoke('models:list', providerId)
  },

  avatars: {
    pick: () => ipcRenderer.invoke('avatars:pick'),
    saveData: (dataUrl: string) => ipcRenderer.invoke('avatars:saveData', dataUrl)
  },

  images: {
    pick: () => ipcRenderer.invoke('images:pick'),
    saveData: (dataUrl: string) => ipcRenderer.invoke('images:saveData', dataUrl)
  },

  data: {
    stats: () => ipcRenderer.invoke('data:stats')
  },

  chat: {
    listSessions: () => ipcRenderer.invoke('chat:listSessions'),
    createSession: (target: unknown, title?: string) => ipcRenderer.invoke('chat:createSession', target, title),
    updateSession: (id: string, patch: unknown) => ipcRenderer.invoke('chat:updateSession', id, patch),
    deleteSession: (id: string) => ipcRenderer.invoke('chat:deleteSession', id),
    getMessages: (id: string) => ipcRenderer.invoke('chat:getMessages', id),
    stop: (id: string) => ipcRenderer.invoke('chat:stop', id),
    active: () => ipcRenderer.invoke('chat:active') as Promise<string[]>,
    listFolders: () => ipcRenderer.invoke('chat:listFolders'),
    createFolder: (name: string) => ipcRenderer.invoke('chat:createFolder', name),
    renameFolder: (id: string, name: string) => ipcRenderer.invoke('chat:renameFolder', id, name),
    deleteFolder: (id: string) => ipcRenderer.invoke('chat:deleteFolder', id),
    send: (opts: unknown) => ipcRenderer.send('chat:send', opts),
    onEvent: (cb: (e: unknown) => void) => {
      const fn = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('chat:event', fn)
      return () => {
        ipcRenderer.removeListener('chat:event', fn)
      }
    }
  },

  memory: {
    global: () => ipcRenderer.invoke('memory:global'),
    session: (sessionId: string) => ipcRenderer.invoke('memory:session', sessionId),
    clearSession: (sessionId: string) => ipcRenderer.invoke('memory:clearSession', sessionId)
  },

  codex: {
    listSessions: () => ipcRenderer.invoke('codex:listSessions'),
    createSession: (workdir: string, target: unknown) => ipcRenderer.invoke('codex:createSession', workdir, target),
    updateSession: (id: string, patch: unknown) => ipcRenderer.invoke('codex:updateSession', id, patch),
    deleteSession: (id: string) => ipcRenderer.invoke('codex:deleteSession', id),
    stop: (id: string) => ipcRenderer.invoke('codex:stop', id),
    active: () => ipcRenderer.invoke('codex:active') as Promise<string[]>,
    listFolders: () => ipcRenderer.invoke('codex:listFolders'),
    createFolder: (name: string) => ipcRenderer.invoke('codex:createFolder', name),
    renameFolder: (id: string, name: string) => ipcRenderer.invoke('codex:renameFolder', id, name),
    deleteFolder: (id: string) => ipcRenderer.invoke('codex:deleteFolder', id),
    send: (opts: unknown) => ipcRenderer.send('codex:send', opts),
    approve: (approvalId: string, approved: boolean) => ipcRenderer.send('codex:approve', approvalId, approved),
    onEvent: (cb: (e: unknown) => void) => {
      const fn = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('codex:event', fn)
      return () => {
        ipcRenderer.removeListener('codex:event', fn)
      }
    }
  },

  bots: {
    list: () => ipcRenderer.invoke('bots:list'),
    upsert: (bot: unknown) => ipcRenderer.invoke('bots:upsert', bot),
    delete: (id: string) => ipcRenderer.invoke('bots:delete', id),
    getMessages: (botId: string) => ipcRenderer.invoke('bots:getMessages', botId),
    getMemory: (botId: string) => ipcRenderer.invoke('bots:getMemory', botId),
    stop: (botId: string) => ipcRenderer.invoke('bots:stop', botId),
    active: () => ipcRenderer.invoke('bots:active') as Promise<string[]>,
    send: (opts: unknown) => ipcRenderer.send('bots:send', opts),
    onEvent: (cb: (e: unknown) => void) => {
      const fn = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('bot:event', fn)
      return () => {
        ipcRenderer.removeListener('bot:event', fn)
      }
    }
  },

  groups: {
    list: () => ipcRenderer.invoke('groups:list'),
    create: (name: string, botIds: string[]) => ipcRenderer.invoke('groups:create', name, botIds),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('groups:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('groups:delete', id),
    getMessages: (groupId: string) => ipcRenderer.invoke('groups:getMessages', groupId),
    stop: (groupId: string) => ipcRenderer.invoke('groups:stop', groupId),
    send: (opts: unknown) => ipcRenderer.send('groups:send', opts),
    onEvent: (cb: (e: unknown) => void) => {
      const fn = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('group:event', fn)
      return () => {
        ipcRenderer.removeListener('group:event', fn)
      }
    }
  },

  ollama: {
    status: () => ipcRenderer.invoke('ollama:status'),
    deleteModel: (m: string) => ipcRenderer.invoke('ollama:deleteModel', m),
    install: (setup: string, dir: string, modelsDir: string) => ipcRenderer.invoke('ollama:install', setup, dir, modelsDir),
    start: (dir: string) => ipcRenderer.invoke('ollama:start', dir),
    findSetup: (dir: string) => ipcRenderer.invoke('ollama:findSetup', dir),
    pull: (model: string) => ipcRenderer.send('ollama:pull', model),
    onPullEvent: (cb: (e: unknown) => void) => {
      const fn = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('ollama:pull-event', fn)
      return () => {
        ipcRenderer.removeListener('ollama:pull-event', fn)
      }
    },
    openDownloadPage: () => ipcRenderer.invoke('ollama:openDownloadPage')
  },

  comfy: {
    status: () => ipcRenderer.invoke('comfy:status'),
    start: () => ipcRenderer.invoke('comfy:start'),
    models: () => ipcRenderer.invoke('comfy:models')
  },

  gen: {
    list: (kind: 'image' | 'video' | 'audio') => ipcRenderer.invoke('gen:list', kind),
    create: (kind: 'image' | 'video' | 'audio', modelId?: string) => ipcRenderer.invoke('gen:create', kind, modelId),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('gen:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('gen:delete', id),
    messages: (id: string) => ipcRenderer.invoke('gen:messages', id),
    send: (opts: unknown) => ipcRenderer.send('gen:send', opts),
    stop: (id: string) => ipcRenderer.send('gen:stop', id),
    active: () => ipcRenderer.invoke('gen:active') as Promise<string[]>,
    onEvent: (cb: (e: unknown) => void) => {
      const fn = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('gen:event', fn)
      return () => {
        ipcRenderer.removeListener('gen:event', fn)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
