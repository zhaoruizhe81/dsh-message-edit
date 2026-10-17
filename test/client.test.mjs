/**
 * 浏览器半边的纯逻辑：快照里取正文、轮次里取改写、状态面的读写与失败折叠。
 *
 * 这里用假 `window.__ModuleLoader__` 把 `lib/client.js` 当闭包工厂跑一遍——
 * 和宿主页面加载它的方式一致，只是 require 换成了桩。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

let spec = null
globalThis.window = {
  __ModuleLoader__: {
    load(candidate) { spec = candidate },
  },
}
await import(pathToFileURL(new URL('../lib/client.js', import.meta.url).pathname).href)

/** React / react-dom 的最小桩：模块体只解构，不在装载期调用。 */
const fakeRequire = (name) => {
  if (name === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useCallback: fn => fn,
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useState: value => [value, () => {}],
    }
  }
  if (name === 'react-dom') return { createPortal: node => node }
  throw new Error(`client bundle required an unexpected module: ${name}`)
}

const client = spec.factory(fakeRequire)
const {
  assistantText, messageTextOfSnapshot, editedIdsInTurn, idsKeyOf, createStore, EditSurface, callApi, COPY, NS, API,
} = client.__internals

test('bundle 导出了 apply / inject，模块 id 与包名一致', () => {
  assert.equal(spec.id, 'dsh-message-edit')
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.equal(NS, 'messageEdit')
  assert.equal(API, '/api/dsh-message-edit')
})

test('中英字典键集合一致', () => {
  assert.deepEqual(Object.keys(COPY.zh).sort(), Object.keys(COPY.en).sort())
  for (const value of Object.values(COPY)) {
    assert.equal(Object.values(value).every(text => typeof text === 'string' && text !== ''), true)
  }
})

test('assistantText 只拼文本块，坏输入不炸', () => {
  assert.equal(assistantText([{ kind: 'reasoning', text: 'r' }, { kind: 'text', text: '你' }, { kind: 'text', text: '好' }]), '你好')
  assert.equal(assistantText(undefined), '')
  assert.equal(assistantText([null, 42, { kind: 'text' }]), '')
})

/** 一份最小可用的 Chat 快照：nodes 按 key 取，locations 按轮取 key。 */
function snapshotOf(turnNodes) {
  const all = new Map()
  const byTurn = new Map()
  for (const [turn, nodes] of Object.entries(turnNodes)) {
    byTurn.set(Number(turn), nodes.map(node => {
      all.set(node.key, node)
      return node.key
    }))
  }
  return {
    nodes: { get: key => all.get(key), values: () => [...all.values()] },
    locations: { getTurn: turn => byTurn.get(turn) ?? [] },
  }
}

function assistantNode(key, messageId, blocks) {
  return { key, kind: 'assistant-step', data: { finalNode: { messageId, blocks } } }
}

test('messageTextOfSnapshot 按消息 id 取正文', () => {
  const snapshot = snapshotOf({
    1: [
      assistantNode('k1', 'm1', [{ kind: 'text', text: '第一条' }]),
      assistantNode('k2', 'm2', [{ kind: 'text', text: '第二条' }]),
    ],
  })
  assert.equal(messageTextOfSnapshot(snapshot, 'm2'), '第二条')
  assert.equal(messageTextOfSnapshot(snapshot, '不存在'), '')
  assert.equal(messageTextOfSnapshot(snapshot, null), '')
  assert.equal(messageTextOfSnapshot(undefined, 'm1'), '')
  assert.equal(messageTextOfSnapshot({ nodes: {} }, 'm1'), '')
  assert.equal(messageTextOfSnapshot({ nodes: { values: () => [{}] } }, 'm1'), '')
})

test('editedIdsInTurn 只认这一轮里被改写的消息', () => {
  const snapshot = snapshotOf({
    1: [assistantNode('k1', 'm1', []), assistantNode('k2', 'm2', [])],
    2: [assistantNode('k3', 'm3', [])],
  })
  assert.equal(editedIdsInTurn(snapshot, 1, 'm2\nm9'), 'm2')
  assert.equal(editedIdsInTurn(snapshot, 1, 'm1\nm2'), 'm1\nm2')
  assert.equal(editedIdsInTurn(snapshot, 2, 'm1'), '')
  assert.equal(editedIdsInTurn(snapshot, 1, ''), '')
  assert.equal(editedIdsInTurn(undefined, 1, 'm1'), '')
  assert.equal(editedIdsInTurn({}, 1, 'm1'), '')
  assert.equal(editedIdsInTurn({ locations: { getTurn: () => undefined } }, 1, 'm1'), '')
})

test('idsKeyOf 排序拼行，空集合是空串', () => {
  assert.equal(idsKeyOf(new Map()), '')
  assert.equal(idsKeyOf(new Map([['b', {}], ['a', {}]])), 'a\nb')
  assert.equal(idsKeyOf(undefined), '')
})

test('createStore：引用不变就不通知', () => {
  const store = createStore({ n: 0 })
  let hits = 0
  const off = store.subscribe(() => { hits += 1 })
  const first = store.getSnapshot()
  store.set(first)
  assert.equal(hits, 0)
  store.set({ n: 1 })
  assert.equal(hits, 1)
  assert.equal(store.getSnapshot().n, 1)
  off()
  store.set({ n: 2 })
  assert.equal(hits, 1)
})

test('createStore：一个订阅者抛异常不影响其他订阅者', () => {
  const store = createStore({ n: 0 })
  let hits = 0
  store.subscribe(() => { throw new Error('boom') })
  store.subscribe(() => { hits += 1 })
  const originalError = console.error
  console.error = () => {}
  try {
    store.set({ n: 1 })
  } finally {
    console.error = originalError
  }
  assert.equal(hits, 1)
})

/** 一个只认我们那四个路由的 fetch 桩。 */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const entry = { url, init }
    calls.push(entry)
    const body = handler(url, init)
    return {
      status: body?.status ?? 200,
      async json() {
        return 'broken' in (body ?? {}) ? (() => { throw new Error('not json') })() : body
      },
    }
  }
  return calls
}

test('EditSurface：装载一次列表，设置与 idsKey 一起落进状态', async () => {
  const calls = stubFetch((url) => {
    assert.match(url, /^\/api\/dsh-message-edit\/list\?sessionId=s1$/)
    return {
      ok: true,
      settings: { transcriptCard: false, maxChars: 1234 },
      items: [
        { messageId: 'm1', text: '改写一', version: 'v1', createdAt: 1, updatedAt: 2 },
        { messageId: 'm2', text: '改写二', version: 'v2', createdAt: 3, updatedAt: 4 },
        { bad: true },
      ],
    }
  })
  const surface = new EditSurface('s1')
  await new Promise(resolve => setTimeout(resolve, 0))
  const view = surface.items.getSnapshot()
  assert.equal(view.status, 'ready')
  assert.equal(view.items.size, 2)
  assert.equal(view.idsKey, 'm1\nm2')
  assert.equal(view.settings.transcriptCard, false)
  assert.equal(view.settings.maxChars, 1234)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.credentials, 'same-origin')
})

test('EditSurface：列表拉失败只改状态，不抛异常', async () => {
  globalThis.fetch = async () => { throw new Error('offline') }
  const surface = new EditSurface('s2')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(surface.items.getSnapshot().status, 'error')
})

test('EditSurface：保存成功会折进列表并关掉面板', async () => {
  const calls = stubFetch((url, init) => {
    if (url.startsWith(`${API}/list`)) return { ok: true, items: [] }
    assert.equal(url, `${API}/put`)
    assert.deepEqual(JSON.parse(init.body), { sessionId: 's3', messageId: 'm9', text: '新回答' })
    return { ok: true, item: { messageId: 'm9', text: '新回答', version: 'v', createdAt: 1, updatedAt: 2 } }
  })
  const surface = new EditSurface('s3')
  await new Promise(resolve => setTimeout(resolve, 0))
  surface.openEditor('m9')
  assert.equal(surface.editor.getSnapshot().open, true)
  await surface.save('新回答')
  assert.equal(surface.items.getSnapshot().items.get('m9').text, '新回答')
  assert.equal(surface.items.getSnapshot().idsKey, 'm9')
  assert.equal(surface.editor.getSnapshot().open, false)
  assert.equal(calls.length, 2)
})

test('EditSurface：保存失败留在面板上，带错误码', async () => {
  stubFetch((url) => url.startsWith(`${API}/list`)
    ? { ok: true, items: [] }
    : { status: 413, ok: false, error: { code: 'text-too-large' } })
  const surface = new EditSurface('s4')
  await new Promise(resolve => setTimeout(resolve, 0))
  surface.openEditor('m1')
  await surface.save('太长了')
  const editor = surface.editor.getSnapshot()
  assert.equal(editor.open, true)
  assert.equal(editor.saving, false)
  assert.equal(editor.error, 'text-too-large')
  assert.equal(surface.items.getSnapshot().items.size, 0)
})

test('EditSurface：恢复原文删掉记录', async () => {
  stubFetch((url) => {
    if (url.startsWith(`${API}/list`)) {
      return { ok: true, items: [{ messageId: 'm1', text: '改写', version: 'v', createdAt: 1, updatedAt: 2 }] }
    }
    assert.equal(url, `${API}/delete`)
    return { ok: true, removed: true }
  })
  const surface = new EditSurface('s5')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(surface.items.getSnapshot().items.size, 1)
  surface.openEditor('m1')
  await surface.restore()
  assert.equal(surface.items.getSnapshot().items.size, 0)
  assert.equal(surface.editor.getSnapshot().open, false)
})

test('EditSurface：面板关闭时保存是空操作', async () => {
  let hits = 0
  stubFetch(() => { hits += 1; return { ok: true, items: [] } })
  const surface = new EditSurface('s6')
  await new Promise(resolve => setTimeout(resolve, 0))
  await surface.save('没有打开的面板')
  assert.equal(hits, 1, '只应有装载那一次请求')
})

test('callApi：网络异常与非 JSON 都折成错误码，不抛', async () => {
  globalThis.fetch = async () => { throw new Error('boom') }
  assert.deepEqual(await callApi('/status'), { ok: false, error: { code: 'host-unreachable' } })

  globalThis.fetch = async () => ({ status: 502, json: async () => { throw new Error('html') } })
  assert.deepEqual(await callApi('/status'), { ok: false, error: { code: 'http-502' } })
})
