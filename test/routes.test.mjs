/**
 * /api/dsh-message-edit/*：四个路由的状态码、失败码、以及"该拦的拦截"。
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { API_BASE, createRoutes } from '../lib/routes.js'
import { EditStore } from '../lib/store.js'

class FakeResponse {
  constructor() {
    this.statusCode = 200
    this.headers = {}
    this.payload = undefined
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value
  }

  end(payload) {
    this.payload = payload
  }

  get json() {
    return JSON.parse(this.payload)
  }
}

function fakeRequest({ method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function harness({ resolveMessage, settings } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-routes-'))
  const store = new EditStore({ dir })
  await store.load()
  const routes = createRoutes({ store, settings: settings ?? {}, resolveMessage })
  const byPath = new Map(routes.map(route => [route.path, route]))
  return {
    store,
    paths: [...byPath.keys()],
    call: async (path, request) => {
      const route = byPath.get(path)
      assert.notEqual(route, undefined, `没有这条路由：${path}`)
      const res = new FakeResponse()
      await route.handler(request, res)
      return res
    },
  }
}

test('四个路由都在 /api/dsh-message-edit 下', async () => {
  const h = await harness()
  assert.deepEqual(h.paths, [`${API_BASE}/status`, `${API_BASE}/list`, `${API_BASE}/put`, `${API_BASE}/delete`])
})

test('status 回宿主设置', async () => {
  const h = await harness({ settings: { enabled: true, rewriteInContext: false, transcriptCard: true } })
  const res = await h.call(`${API_BASE}/status`, fakeRequest())
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.settings.rewriteInContext, false)
  assert.equal(res.json.settings.maxChars, h.store.maxChars)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('list 需要 sessionId，回这个会话的改写', async () => {
  const h = await harness()
  await h.store.put({ sessionId: 's1', messageId: 'm1', text: '改写一', original: '原文一' })
  await h.store.put({ sessionId: 's2', messageId: 'm2', text: '改写二' })

  const missing = await h.call(`${API_BASE}/list`, fakeRequest({ url: `${API_BASE}/list` }))
  assert.equal(missing.statusCode, 400)
  assert.equal(missing.json.error.code, 'invalid-session')

  const res = await h.call(`${API_BASE}/list`, fakeRequest({ url: `${API_BASE}/list?sessionId=s1` }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.items.length, 1)
  assert.equal(res.json.items[0].messageId, 'm1')
  assert.equal(res.json.items[0].text, '改写一')
  assert.equal(res.json.items[0].original, '原文一', '原文快照随改写一起回来，供面板对照')
})

test('put 落一条，再 list 看得到', async () => {
  const h = await harness()
  const res = await h.call(`${API_BASE}/put`, fakeRequest({
    method: 'POST',
    body: { sessionId: 's1', messageId: 'm1', text: '改写后的回答', original: '原始回答' },
  }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.item.messageId, 'm1')
  assert.equal(h.store.getItem('s1', 'm1').text, '改写后的回答')

  const list = await h.call(`${API_BASE}/list`, fakeRequest({ url: `${API_BASE}/list?sessionId=s1` }))
  assert.equal(list.json.items.length, 1)
})

test('方法不对就 405，别的方法一律不动记录', async () => {
  const h = await harness()
  const res = await h.call(`${API_BASE}/put`, fakeRequest({ method: 'GET' }))
  assert.equal(res.statusCode, 405)
  assert.equal(res.json.error.code, 'method-not-allowed')
  assert.equal((await h.call(`${API_BASE}/status`, fakeRequest({ method: 'POST', body: {} }))).statusCode, 405)
})

test('请求体坏掉就 400，不写任何东西', async () => {
  const h = await harness()
  const res = await h.call(`${API_BASE}/put`, fakeRequest({ method: 'POST', body: '{ 这不是 json' }))
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.error.code, 'invalid-body')

  const array = await h.call(`${API_BASE}/put`, fakeRequest({ method: 'POST', body: '[1,2,3]' }))
  assert.equal(array.statusCode, 400)
  assert.equal(array.json.error.code, 'invalid-body')
})

test('请求体超限就 400 body-too-large', async () => {
  const h = await harness()
  const huge = JSON.stringify({ sessionId: 's', messageId: 'm', text: 'x'.repeat(1024 * 1024 + 16) })
  const res = await h.call(`${API_BASE}/put`, fakeRequest({ method: 'POST', body: huge }))
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.error.code, 'body-too-large')
})

test('目标不存在（本地查得到会话时）就 404', async () => {
  const h = await harness({ resolveMessage: () => false })
  const res = await h.call(`${API_BASE}/put`, fakeRequest({
    method: 'POST',
    body: { sessionId: 's', messageId: 'm', text: 'x' },
  }))
  assert.equal(res.statusCode, 404)
  assert.equal(res.json.error.code, 'target-not-found')
  assert.equal(h.store.listItems('s').length, 0)
})

test('查不到会话时不拦（冷会话也能改写）', async () => {
  const h = await harness({ resolveMessage: () => undefined })
  const res = await h.call(`${API_BASE}/put`, fakeRequest({
    method: 'POST',
    body: { sessionId: 's', messageId: 'm', text: 'x' },
  }))
  assert.equal(res.statusCode, 200)
})

test('校验器抛异常不影响服务', async () => {
  const h = await harness({ resolveMessage: () => { throw new Error('boom') } })
  const res = await h.call(`${API_BASE}/put`, fakeRequest({
    method: 'POST',
    body: { sessionId: 's', messageId: 'm', text: 'x' },
  }))
  assert.equal(res.statusCode, 200)
})

test('太长就 413', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-routes-'))
  const store = new EditStore({ dir, maxChars: 4 })
  await store.load()
  const routes = createRoutes({ store })
  const put = routes.find(route => route.path === `${API_BASE}/put`)
  const res = new FakeResponse()
  await put.handler(fakeRequest({ method: 'POST', body: { sessionId: 's', messageId: 'm', text: '12345' } }), res)
  assert.equal(res.statusCode, 413)
  assert.equal(res.json.error.code, 'text-too-large')
})

test('delete 删掉一条；删不存在的也回 ok', async () => {
  const h = await harness()
  await h.store.put({ sessionId: 's', messageId: 'm', text: 'x' })
  const first = await h.call(`${API_BASE}/delete`, fakeRequest({ method: 'POST', body: { sessionId: 's', messageId: 'm' } }))
  assert.equal(first.statusCode, 200)
  assert.equal(first.json.removed, true)
  const second = await h.call(`${API_BASE}/delete`, fakeRequest({ method: 'POST', body: { sessionId: 's', messageId: 'm' } }))
  assert.equal(second.statusCode, 200)
  assert.equal(second.json.removed, false)
})

test('缺字段一律 400，且码能对上', async () => {
  const h = await harness()
  const cases = [
    [{ text: 'x' }, 'invalid-session'],
    [{ sessionId: 's' }, 'invalid-target'],
    [{ sessionId: 's', messageId: 'm' }, 'invalid-text'],
    [{ sessionId: 's', messageId: 'm', text: 42 }, 'invalid-text'],
  ]
  for (const [body, code] of cases) {
    const res = await h.call(`${API_BASE}/put`, fakeRequest({ method: 'POST', body }))
    assert.equal(res.statusCode, 400, JSON.stringify(body))
    assert.equal(res.json.error.code, code)
  }
})
