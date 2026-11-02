/**
 * 联网搜索 —— 支持免密钥的 DuckDuckGo 与 Tavily / 博查。
 * 请求走 Electron net（Chromium 网络栈，自动跟随系统代理）。
 * 免费回退链：所选引擎失败/无结果 → Bing（国内可直连）→ 才报错。
 */
import { net } from 'electron'
import { loadSettings, getSearchKey } from './store'
import { completeOnce } from './llm'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 各引擎的单次请求超时：DuckDuckGo 在国内经常连不通，之前会干等 20s+ 才落兜底，用户体感像卡死 */
const TIMEOUT_MS = 8000

// ---------- 查询词精炼 ----------
// 用户原话是"搜一下最近有什么 AI 新闻"，直接拿整句去搜，搜索引擎会把"搜一下"当成主体，
// 返回"搜狗/搜狐"这类完全无关的页面（本机实测）。所以搜之前先把问题压成关键词。

const CHATTY_PREFIX =
  /^(?:请|麻烦|帮我|帮忙|给我)?\s*(?:搜一下|搜一搜|搜搜|搜索一下|搜索|查一下|查一查|查查|找一下|找找|看一下|看看|了解一下|我想知道|想知道)\s*/i
const FUZZY = /(最近|近期|最新|有什么|有哪些|怎么样|如何|是什么|为什么|能不能|可不可以|推荐|介绍|一下)/

function cleanQuery(q: string): string {
  return q
    .trim()
    .replace(/^[「『"'“]|[」』"'”]$/g, '')
    .replace(/[。！？?!～~]+$/g, '')
    .replace(CHATTY_PREFIX, '')
    .replace(/[。！？?!～~]+$/g, '')
    .trim()
}

/** 太口语化 / 太长 / 带模糊词 → 让模型压成搜索引擎友好的一行关键词 */
function needsRewrite(s: string): boolean {
  return s.length > 22 || FUZZY.test(s)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ])
}

/**
 * 把用户口语问题压成搜索关键词。
 * 能用正则洗掉的就直接用（快、不依赖模型），仍带模糊词才问一次小模型；
 * 模型失败/超时一律回落「清洗后的原话」，保证搜索永远能发出去。
 *
 * 实测教训：中文关键词**必须用空格分隔**——"最近AI新闻" 会被 Bing 切成"最近"，
 * 返回《最近》这首歌和汉语词典；"人工智能 AI 新闻 最新" 才是正常新闻结果。
 */
export async function refineSearchQuery(raw: string): Promise<string> {
  const cleaned = cleanQuery(raw)
  const base = cleaned || raw.trim()
  if (!needsRewrite(base)) return base
  try {
    const s = loadSettings()
    const out = await withTimeout(
      completeOnce(
        { providerId: s.defaultProviderId, model: s.defaultModel },
        [
          {
            role: 'user',
            content:
              '你是搜索关键词改写器。把用户问题改写成 2~5 个搜索关键词，**关键词之间必须用空格分开**。\n' +
              '规则：\n' +
              '1) 只输出关键词本身，不要句子、引号、编号、解释\n' +
              '2) 专有名词原样保留（DeepSeek、GPT、Bing 等品牌名）\n' +
              '3) **不要中英混排**：同一个概念只留一种写法，优先中文（要写「人工智能」就别再写 AI）\n' +
              '4) 时间词统一用「最新」，不要用「最近 / 近期 / 现在」\n' +
              '5) 中文关键词也要用空格断开，方便搜索引擎分词\n' +
              '示例：\n' +
              '用户：搜一下最近有什么 AI 新闻 → 人工智能 最新 新闻\n' +
              '用户：帮我查下明天北京天气 → 北京 天气 明天\n' +
              '用户：介绍一下 DeepSeek 最新的模型 → DeepSeek 最新 模型\n' +
              '问题：' +
              base
          }
        ],
        { temperature: 0.1, maxTokens: 80 }
      ),
      9000
    )
    const t = out
      .trim()
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)[0]
      ?.replace(/^["'「」『』]|["'「」『』]$/g, '')
      .replace(/[。！？?!]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (t && t.length >= 2 && t.length <= 60) {
      const refined = depollute(t)
      console.log(`[search] 关键词精炼: "${base}" -> "${refined}"`)
      return refined
    }
    console.log(`[search] 精炼结果不可用("${t}")，回落原话`)
  } catch (e) {
    console.log(`[search] 精炼失败(${e instanceof Error ? e.message : e})，回落原话`)
  }
  return depollute(base)
}

/** 混排会翻车：Bing 对「人工智能 AI 新闻 最新」这种中英混着写的中文查询会返回词典页，
 *  纯中文（人工智能 最新新闻）才正常。这里程序化兜一道，不指望模型每次都听话。 */
function depollute(q: string): string {
  let s = q
  if (/人工智能|科技|模型/.test(s) && /\bAI\b/i.test(s)) {
    s = s.replace(/\bAI\b/gi, ' ')
  }
  return s.replace(/\s+/g, ' ').trim() || q
}

/** 取 query 里的"关键词块"：英文词 + 中文 2-gram，用于判断结果是否跑偏 */
function keywordsOf(q: string): string[] {
  const ascii = (q.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? []).map((x) => x.toLowerCase())
  const cn: string[] = []
  for (const seg of q.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (seg.length <= 4) cn.push(seg)
    else for (let i = 0; i + 2 <= seg.length; i++) cn.push(seg.slice(i, i + 2))
  }
  return [...new Set([...ascii, ...cn])]
}

/** 结果里连一个关键词都命中不了 → 基本可以判定搜索引擎跑偏了（如"AI 新闻"搜出《最近》这首歌） */
function looksOffTopic(q: string, results: SearchResult[]): boolean {
  if (!results.length) return false
  const kws = keywordsOf(q)
  if (!kws.length) return false
  return !results.some((r) => {
    const text = (r.title + ' ' + r.snippet).toLowerCase()
    return kws.some((k) => text.includes(k))
  })
}

/** DuckDuckGo 在国内经常连不通：失败后 10 分钟内直接走 Bing，避免每次都白等 8 秒超时 */
let ddgDownUntil = 0

async function searchOnce(q: string, count: number): Promise<SearchResult[]> {
  const s = loadSettings()
  let lastErr: unknown
  try {
    if (s.searchProvider === 'tavily') return await tavilySearch(q, count)
    if (s.searchProvider === 'bocha') return await bochaSearch(q, count)
    if (Date.now() < ddgDownUntil) throw new Error('DuckDuckGo 近期不可用，改用 Bing')
    try {
      return await ddgSearch(q, count)
    } catch (e) {
      ddgDownUntil = Date.now() + 10 * 60 * 1000
      throw e
    }
  } catch (e) {
    lastErr = e
  }
  // 免费兜底：Bing 国内直连（不依赖代理与 Key）
  try {
    const r = await bingSearch(q, count)
    if (r.length) return r
  } catch {
    /* 用原始错误报给用户 */
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function webSearch(
  query: string,
  count = 6,
  opts?: { refine?: boolean }
): Promise<SearchResult[]> {
  // refine 默认开：入口处统一把口语问题压成关键词；Codex 的工具调用本身给的就是关键词，可传 false
  const q = opts?.refine === false ? query : await refineSearchQuery(query)
  const results = await searchOnce(q, count)
  if (!looksOffTopic(q, results)) return results
  // 结果完全跑偏（如"人工智能 最新 新闻"搜出《最近》这首歌）→ 去掉时间虚词、去混排再搜一次
  const alt = depollute(q.replace(/(最近|近期|现在|如今|最新)/g, ' '))
  if (alt && alt !== q) {
    try {
      const r2 = await searchOnce(alt, count)
      if (r2.length && !looksOffTopic(alt, r2)) {
        console.log(`[search] 结果跑偏，改用 "${alt}" 重搜成功`)
        return r2
      }
    } catch {
      /* 重搜失败走下面 */
    }
  }
  // 两次都跑偏：宁可不给结果，也不要把《最近》这首歌喂给模型让它编新闻
  console.log(`[search] "${q}" 的结果与问题无关，放弃返回`)
  return []
}

// ---------- Tavily ----------

async function tavilySearch(query: string, count: number): Promise<SearchResult[]> {
  const key = getSearchKey('tavily')
  if (!key) throw new Error('未配置 Tavily Key，请在设置中填写')
  const res = await net.fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: count }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`Tavily 搜索失败 (${res.status})`)
  const json = await res.json()
  return (json.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }))
}

// ---------- 博查 ----------

async function bochaSearch(query: string, count: number): Promise<SearchResult[]> {
  const key = getSearchKey('bocha')
  if (!key) throw new Error('未配置博查 Key，请在设置中填写')
  const res = await net.fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, count }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`博查搜索失败 (${res.status})`)
  const json = await res.json()
  return (json?.data?.webPages?.value ?? []).map((r: any) => ({
    title: r.name,
    url: r.url,
    snippet: r.summary ?? r.snippet
  }))
}

// ---------- DuckDuckGo（走系统代理；被墙时由 Bing 兜底） ----------

async function ddgSearch(query: string, count: number): Promise<SearchResult[]> {
  const res = await net.fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`DuckDuckGo 搜索失败 (${res.status})`)
  const html = await res.text()
  const results: SearchResult[] = []
  const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) && results.length < count) {
    results.push({
      title: stripTags(m[2]),
      url: decodeDdg(m[1]),
      snippet: stripTags(m[3])
    })
  }
  return results
}

// ---------- Bing（国内直连兜底） ----------

async function bingSearch(query: string, count: number): Promise<SearchResult[]> {
  const res = await net.fetch(
    'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&count=' + count + '&setlang=zh-hans',
    {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Accept: 'text/html'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }
  )
  if (!res.ok) throw new Error(`Bing 搜索失败 (${res.status})`)
  const html = await res.text()
  const results: SearchResult[] = []
  // <li class="b_algo"> … <h2><a href="…">标题</a></h2> … <p>摘要</p>
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && results.length < count) {
    const title = stripTags(m[2])
    if (!title || !m[1].startsWith('http')) continue
    results.push({ title, url: m[1].replace(/&amp;/g, '&'), snippet: stripTags(m[3]) })
  }
  return results
}

// ---------- 通用工具 ----------

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeDdg(u: string): string {
  if (u.startsWith('//duckduckgo.com/l/?uddg=')) {
    try {
      const q = new URL('https:' + u)
      return decodeURIComponent(q.searchParams.get('uddg') ?? u)
    } catch {
      return u
    }
  }
  return u
}
