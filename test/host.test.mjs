/**
 * 宿主半边的接线，跑在**真的 cordis** 上。
 *
 * 为什么不用手搓的假 ctx：第一版就是那么测的，结果漏掉了一个致命细节——
 * `ctx.llm` 这种属性访问只对声明在 `inject` 里的服务成立，没声明时它安静地给
 * `undefined`。手搓的 ctx 里 `llm` 是个普通属性，永远读得到，于是测试全绿、
 * 真机上改写一条都没生效。真 cordis + provide 出来的服务才问得出这个问题。
 *
 * cordis 从本机 dsh 源码 checkout 借（或插件自己的 node_modules）；借不到整段跳过。
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { DEFAULTS, apply, inject, name, normalizeConfig } from '../lib/index.js'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** pnpm 不把依赖摊到根 node_modules，得去 .pnpm 里按名找。 */
function resolveInPnpmStore(root, specifier) {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  const prefix = `${specifier.replace('/', '+')}@`
  const entry = readdirSync(store).find(candidate => candidate.startsWith(prefix))
  if (entry === undefined) return undefined
  const resolved = join(store, entry, 'node_modules', specifier)
  return existsSync(join(resolved, 'package.json')) ? resolved : undefined
}

/** 在几个候选根目录里找一个包，返回包目录。 */
function resolvePackage(specifier, roots) {
  for (const root of roots) {
    if (root === '' || !existsSync(join(root, 'package.json'))) continue
    // dsh 把 cordis 家族 vendored 在源码树里，构建产物就在 vendor/<name>/lib。
    const vendored = join(root, 'vendor', specifier.split('/').pop() ?? '')
    if (specifier.startsWith('@deepseek-ai/') && existsSync(join(vendored, 'package.json'))) return vendored
    try {
      const entry = createRequire(join(root, 'package.json')).resolve(specifier)
      const marker = join('node_modules', ...specifier.split('/'))
      const at = entry.lastIndexOf(marker)
      if (at !== -1) return entry.slice(0, at + marker.length)
      return dirname(entry)
    } catch {
      const pinned = resolveInPnpmStore(root, specifier)
      if (pinned !== undefined) return pinned
    }
  }
  return undefined
}

const roots = [
  pluginRoot,
  process.env.DSH_SOURCE_DIR ?? '',
  join(pluginRoot, '..', 'deepseek-harness'),
  '/Users/zhaoruizhe/Desktop/project/P/deepseek-harness',
]

const cordisRoot = resolvePackage('@deepseek-ai/cordis', roots)
const skipReason = cordisRoot === undefined ? '需要 @deepseek-ai/cordis（设 DSH_SOURCE_DIR 指向 dsh 源码）' : false

class FakeResponse {
  constructor() { this.statusCode = 200; this.headers = {}; this.payload = undefined }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value }
  end(payload) { this.payload = payload }
  get json() { return JSON.parse(this.payload) }
}

function fakeRequest({ method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return { method, url, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk } }
}

test('插件身份与依赖声明', () => {
  assert.equal(name, 'message-edit')
  assert.deepEqual([...inject].sort(), ['llm', 'webServer'])
})

test('normalizeConfig 只认自己的字段，坏值退回默认', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    enabled: true, rewriteInContext: true, transcriptCard: true, maxChars: DEFAULTS.maxChars, dataDir: undefined,
  })
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ rewriteInContext: false }).rewriteInContext, false)
  assert.equal(normalizeConfig({ transcriptCard: false }).transcriptCard, false)
  assert.equal(normalizeConfig({ maxChars: -1 }).maxChars, DEFAULTS.maxChars)
  assert.equal(normalizeConfig({ maxChars: 4096 }).maxChars, 4096)
  assert.equal(normalizeConfig({ dataDir: '  ' }).dataDir, undefined)
  assert.equal(normalizeConfig({ dataDir: '/tmp/x' }).dataDir, '/tmp/x')
  assert.equal(normalizeConfig({ dataDir: '  /tmp/y  ' }).dataDir, '/tmp/y')
  assert.equal(normalizeConfig({ dataDir: '~/x' }).dataDir.startsWith('/'), true)
})

if (skipReason !== false) {
  test('真 cordis 套件（依赖不齐，跳过）', { skip: skipReason }, () => {})
} else {
  const { Context } = createRequire(join(cordisRoot, 'package.json'))('@deepseek-ai/cordis')

  /**
   * 挂一个真组合：webServer 与 llm 都由别的 fiber 提供，插件按自己的 inject 拿。
   * @returns ctx、收下的路由、llm 收到的请求、以及一个照 LlmRuntime 方式派发的入口。
   */
  async function mount(config = {}, options = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-host-'))
    const ctx = new Context()
    const routes = new Map()
    ctx.provide('webServer', {
      register: (route) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    })
    const dispatched = []
    if (options.withLlm !== false) {
      ctx.provide('llm', {
        stream: (request) => {
          dispatched.push(request)
          return (async function* empty() {})()
        },
      })
    }
    const fiber = await ctx.plugin({ name, inject, apply }, { dataDir, ...config })
    const call = async (path, request) => {
      const route = routes.get(path)
      assert.notEqual(route, undefined, `没有这条路由：${path}`)
      const res = new FakeResponse()
      await route.handler(request, res)
      return res
    }
    const register = async (sessionId, messageId, text) => {
      const res = await call('/api/dsh-message-edit/put', fakeRequest({
        method: 'POST',
        body: { sessionId, messageId, text },
      }))
      assert.equal(res.json.ok, true, JSON.stringify(res.json))
    }
    /** 完全按 LlmRuntime 的方式派发一次 llm/stream。 */
    const dispatch = (request) => ctx.waterfall(
      ctx.get('llm'),
      'llm/stream',
      request,
      () => ({ marker: 'next' }),
    )
    return { ctx, fiber, routes, dispatched, call, register, dispatch }
  }

  test('enabled: false 时既不装路由也不装监听器', async () => {
    const h = await mount({ enabled: false })
    assert.equal(h.routes.size, 0)
    await h.fiber.dispose()
  })

  test('llm 缺席时插件保持 PENDING：一条路由都不装', async () => {
    const h = await mount({}, { withLlm: false })
    assert.equal(h.routes.size, 0)
    await h.fiber.dispose()
  })

  test('四条路由挂在真 ctx 上，/status 把行配置透出去', async () => {
    const h = await mount({ transcriptCard: false, maxChars: 1234 })
    assert.deepEqual([...h.routes.keys()], [
      '/api/dsh-message-edit/status',
      '/api/dsh-message-edit/list',
      '/api/dsh-message-edit/put',
      '/api/dsh-message-edit/delete',
    ])
    const res = await h.call('/api/dsh-message-edit/status', fakeRequest())
    assert.equal(res.json.settings.transcriptCard, false)
    assert.equal(res.json.settings.maxChars, 1234)
    assert.equal(res.json.settings.rewriteInContext, true)
    await h.fiber.dispose()
  })

  test('没有改写的会话：监听器原样放行', async () => {
    const h = await mount()
    const request = { sessionId: 's1', messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: '原文' }], source: { kind: 'model' } }] }
    const result = h.dispatch(request)
    assert.equal(result.marker, 'next')
    assert.equal(h.dispatched.length, 0)
    await h.fiber.dispose()
  })

  test('命中改写：换成改写后的正文，重新派发一次请求', async () => {
    const h = await mount()
    await h.register('s1', 'm1', '我改写的回答')

    const request = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      sessionId: 's1',
      messages: [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: '提问' }], source: { kind: 'user' } },
        { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '原文' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
      ],
    }
    const result = h.dispatch(request)

    assert.equal(result.marker, undefined, '命中改写时不能再走原请求')
    assert.equal(h.dispatched.length, 1)
    const sent = h.dispatched[0]
    assert.equal(sent.messages[0], request.messages[0], '没被改写的消息保持原引用')
    assert.equal(sent.messages[1].content[0].text, '我改写的回答')
    assert.equal(sent.messages[1].id, 'm1')
    assert.equal(sent.provider, 'deepseek')
    assert.notEqual(sent, request, '请求是新对象，不动原请求')
    await h.fiber.dispose()
  })

  test('守卫：改写后的请求再进一次监听器时原样放行（不会无限重发）', async () => {
    const h = await mount()
    await h.register('s1', 'm1', '我改写的回答')
    const request = { sessionId: 's1', messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: '原文' }], source: { kind: 'model' } }] }
    const rewritten = h.dispatch(request)
    assert.equal(h.dispatched.length, 1)

    const again = h.dispatch(rewritten)
    assert.equal(again.marker, 'next')
    assert.equal(h.dispatched.length, 1, '第二次不再重新派发')
    await h.fiber.dispose()
  })

  test('别的会话的改写不会串进来', async () => {
    const h = await mount()
    await h.register('别的会话', 'm1', '不该出现的改写')
    const request = { sessionId: 's1', messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: '原文' }], source: { kind: 'model' } }] }
    const result = h.dispatch(request)
    assert.equal(result.marker, 'next')
    await h.fiber.dispose()
  })

  test('没有 sessionId 的调用（标题、压缩之类）原样放行', async () => {
    const h = await mount()
    await h.register('s1', 'm1', '我改写的回答')
    const request = { purpose: 'session-title', messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: '原文' }], source: { kind: 'model' } }] }
    const result = h.dispatch(request)
    assert.equal(result.marker, 'next')
    await h.fiber.dispose()
  })

  test('rewriteInContext: false 时不装监听器（只记录）', async () => {
    const h = await mount({ rewriteInContext: false })
    assert.equal(h.routes.size, 4)
    await h.register('s1', 'm1', '我改写的回答')
    const request = { sessionId: 's1', messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: '原文' }], source: { kind: 'model' } }] }
    const result = h.dispatch(request)
    assert.equal(result.marker, 'next')
    await h.fiber.dispose()
  })

  test('监听器内部出错也不吞掉请求：原样放行', async () => {
    const h = await mount()
    await h.register('s1', 'm1', '我改写的回答')
    const boom = { sessionId: 's1', get messages() { throw new Error('boom') } }
    const result = h.dispatch(boom)
    assert.equal(result.marker, 'next')
    assert.equal(h.dispatched.length, 0)
    await h.fiber.dispose()
  })

  test('插件卸载后路由随之消失，别人的服务不受影响', async () => {
    const h = await mount()
    assert.equal(h.routes.size, 4)
    await h.fiber.dispose()
    assert.equal(h.routes.size, 0, '卸载要把它注册的路由摘干净')
    assert.equal(typeof h.ctx.get('webServer')?.register, 'function', 'webServer 是别人的服务')
    assert.notEqual(h.ctx.get('llm'), undefined, 'llm 也是别人的服务')
  })
}
