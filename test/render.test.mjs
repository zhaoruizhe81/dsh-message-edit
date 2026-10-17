/**
 * 真渲染：把 `lib/client.js` 当插件装载，注册进一个假 ctx，再用真 React +
 * jsdom 把三个 slot 条目画出来，敲真的 DOM。
 *
 * 为什么值得写：宿主的 slot 条目一旦抛异常，页面只会留一行
 * `slot entry crashed in '<slot>'`，插件的画面就是"没有"。单元测试测不出
 * 这个——真渲染一次才知道。
 *
 * react / react-dom / jsdom 从本机 dsh 源码 checkout 借（或插件自己的
 * node_modules）；借不到就整段跳过，不让包在不具备条件的机器上假装通过。
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** pnpm 不把依赖摊到根 node_modules，得去 .pnpm 里按名找。 */
function resolveInPnpmStore(root, name) {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  const prefix = `${name.replace('/', '+')}@`
  const entry = readdirSync(store).find(candidate => candidate.startsWith(prefix))
  if (entry === undefined) return undefined
  const resolved = join(store, entry, 'node_modules', name)
  return existsSync(join(resolved, 'package.json')) ? join(resolved, 'package.json') : undefined
}

/** 在几个候选根目录里找一个包，找不到返回 undefined。 */
function resolveOptional(name, roots) {
  for (const root of roots) {
    if (root === '' || !existsSync(join(root, 'package.json'))) continue
    try {
      return createRequire(join(root, 'package.json')).resolve(name)
    } catch {
      const pinned = resolveInPnpmStore(root, name)
      if (pinned === undefined) continue
      return pinned
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

const reactEntry = resolveOptional('react', roots)
const reactDomEntry = resolveOptional('react-dom', roots)
const jsdomEntry = resolveOptional('jsdom', roots)
const missing = [
  reactEntry === undefined ? 'react' : null,
  reactDomEntry === undefined ? 'react-dom' : null,
  jsdomEntry === undefined ? 'jsdom' : null,
].filter(Boolean)
const skipReason = missing.length > 0 ? `缺少 ${missing.join('、')}（设 DSH_SOURCE_DIR 指向 dsh 源码）` : false

if (skipReason !== false) {
  test('渲染套件（依赖不齐，跳过）', { skip: skipReason }, () => {})
} else {
  const { JSDOM } = createRequire(jsdomEntry)('jsdom')

  // jsdom 必须在 require('react-dom') **之前**装好：React DOM 在模块作用域里算
  // 一次 canUseDOM，晚了它就把 textarea 的输入认成 'change' 而不是 'input'，
  // 于是测试里打字永远不触发 onChange（点击照样好用，所以特别容易看走眼）。
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:19387/' })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Node = window.Node
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const reactRequire = createRequire(reactEntry)
  const reactDomRequire = createRequire(reactDomEntry)
  const React = reactRequire('react')
  const ReactDom = reactDomRequire('react-dom')
  const { createRoot } = reactDomRequire('react-dom/client')
  const act = React.act ?? reactDomRequire('react-dom/test-utils').act

  let spec = null
  window.__ModuleLoader__ = { load(candidate) { spec = candidate } }
  await import(pathToFileURL(join(pluginRoot, 'lib', 'client.js')).href)

  const fakeRequire = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return ReactDom
    throw new Error(`unexpected require: ${name}`)
  }
  const client = spec.factory(fakeRequire)
  const { COPY } = client.__internals

  /** 按 bundle 自己的字典翻译；参数替换与宿主那一套同形。 */
  const t = (key, params) => {
    let text = COPY.zh[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
    return text
  }

  /** 一个假 ctx：席位注册、样式表、locale 都收下来。 */
  function fakeContext() {
    const registrations = []
    const ctx = {
      effect: (fn) => {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      on: () => () => {},
      locale: { register: () => () => {} },
      slots: {
        inject: (owner, factory) => { factory(); return () => {} },
        register: (entry, component) => {
          registrations.push({ entry, component })
          return () => {}
        },
      },
    }
    client.apply(ctx)
    return { registrations, find: id => registrations.find(item => item.entry.id === id) }
  }

  /** 把框架那套 hooks 面用真 React 绑出来（框架做的也是这件事）。 */
  function bindHooks(injected) {
    const bound = {}
    for (const [key, store] of Object.entries(injected.hooks ?? {})) {
      const name = `use${key[0].toUpperCase()}${key.slice(1)}`
      bound[name] = (selector) => {
        const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
        return selector(snapshot)
      }
    }
    return bound
  }

  /** 渲染一个 slot 条目；返回容器与重渲染入口。 */
  function mount(registration, sessionId, props) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const injected = registration.entry.inject(sessionId)
    act(() => {
      root.render(React.createElement(registration.component, {
        sessionId,
        t,
        ...bindHooks(injected),
        ...injected,
        ...props,
      }))
    })
    return { container, root, injected }
  }

  /** 一个够用的 Chat 快照：给一个命中指定消息的 assistant 节点。 */
  function chatWith(messageId, text) {
    const node = { kind: 'assistant-step', data: { finalNode: { messageId, blocks: text === undefined ? [] : [{ kind: 'text', text }] } } }
    const nodes = new Map([['k1', node]])
    return {
      nodes: { get: key => nodes.get(key), values: () => [...nodes.values()] },
      locations: { getTurn: () => [...nodes.keys()] },
    }
  }

  function setItems(injected, entries) {
    const items = new Map(entries)
    act(() => {
      injected.hooks.edits.set({ status: 'ready', items, idsKey: [...items.keys()].sort().join('\n'), settings: { transcriptCard: true, maxChars: 20000 } })
    })
  }

  /** 同一条会话的条目共用一份状态面，所以从任一 entry 拿到的 store 都是同一个。 */
  function surfaceOf(ctx, entryId, sessionId) {
    return ctx.find(entryId).entry.inject(sessionId)
  }

  function click(element) {
    act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  }

  /** 往受控输入框里打字：走原生 setter，React 才认这次 change。 */
  async function typeInto(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    await act(async () => {
      setter.call(textarea, value)
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }

  test('apply 注册了三个条目，并挂上一张样式表', () => {
    const ctx = fakeContext()
    assert.deepEqual(ctx.registrations.map(item => item.entry.id), ['message-edit', 'message-edit-card', 'message-edit-dialog'])
    assert.deepEqual(ctx.registrations.map(item => item.entry.name), [
      'conversation.chat.assistant-actions',
      'conversation.chat.turnTail',
      'conversation.input.overlay',
    ])
    assert.notEqual(document.head.querySelector('style[data-plugin="dsh-message-edit"]'), null)
  })

  test('动作按钮画出来，点击打开面板', () => {
    const ctx = fakeContext()
    const registration = ctx.find('message-edit')
    const view = mount(registration, 's1', { messageId: 'm1' })
    const button = view.container.querySelector('button.dsme-action')
    assert.notEqual(button, null)
    assert.equal(button.getAttribute('aria-label'), COPY.zh['action.edit'])
    assert.notEqual(button.querySelector('svg'), null)
    click(button)
    const editor = surfaceOf(ctx, 'message-edit-dialog', 's1').hooks.editor.getSnapshot()
    assert.equal(editor.open, true)
    assert.equal(editor.messageId, 'm1')
    view.root.unmount()
  })

  test('已改写的消息在动作行里带标记', () => {
    const ctx = fakeContext()
    const registration = ctx.find('message-edit')
    const view = mount(registration, 's1', { messageId: 'm1' })
    setItems(view.injected, [['m1', { messageId: 'm1', text: '改写后的回答', version: 'v', createdAt: 1, updatedAt: 2 }]])
    const button = view.container.querySelector('button.dsme-action')
    assert.equal(button.hasAttribute('data-edited'), true)
    assert.notEqual(button.querySelector('.dsme-dot'), null)
    view.root.unmount()
  })

  test('改写卡把改写后的文字铺在对话流里', () => {
    const ctx = fakeContext()
    const registration = ctx.find('message-edit-card')
    const view = mount(registration, 's1', { turn: 1, seq: 5, useChat: selector => selector(chatWith('m1')) })
    setItems(view.injected, [['m1', { messageId: 'm1', text: '我改写的这句台词', version: 'v', createdAt: 1, updatedAt: 2 }]])
    assert.match(view.container.textContent, /已改写/)
    assert.match(view.container.textContent, /我改写的这句台词/)
    view.root.unmount()
  })

  test('这一轮没有改写就不占版面', () => {
    const ctx = fakeContext()
    const registration = ctx.find('message-edit-card')
    const view = mount(registration, 's1', { turn: 1, seq: 5, useChat: selector => selector(chatWith('别的消息')) })
    assert.equal(view.container.querySelector('.dsme-card'), null)
    view.root.unmount()
  })

  test('编辑面板：原文预填、保存走 /put', async () => {
    const ctx = fakeContext()
    const registration = ctx.find('message-edit-dialog')
    const action = ctx.find('message-edit')
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      if (url.startsWith('/api/dsh-message-edit/list')) {
        return { status: 200, json: async () => ({ ok: true, items: [], settings: { maxChars: 20000 } }) }
      }
      return { status: 200, json: async () => ({ ok: true, item: { messageId: 'm1', text: '改写后的回答', version: 'v2', createdAt: 1, updatedAt: 3 } }) }
    }
    // 动作行那颗按钮打开面板：两个条目共用同一条会话的状态面。
    const view = mount(registration, 's1', { useChat: selector => selector(chatWith('m1', '原始回答')) })
    act(() => {
      action.entry.inject('s1').openEditor('m1')
    })

    const textarea = document.querySelector('textarea.dsme-textarea')
    assert.notEqual(textarea, null, '面板打开后必须画出输入框')
    assert.equal(textarea.value, '原始回答', '没改写过时预填的是会话里的原文')
    assert.match(document.querySelector('.dsme-original').textContent, /原始回答/)

    await typeInto(textarea, '改写后的回答')
    assert.equal(document.querySelector('textarea.dsme-textarea').value, '改写后的回答', '输入走 store 草稿')

    const saveButton = [...document.querySelectorAll('button.dsme-button')].find(button => button.textContent === COPY.zh['dialog.save'])
    assert.notEqual(saveButton, undefined)
    await act(async () => {
      saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const put = calls.find(call => call.url === '/api/dsh-message-edit/put')
    assert.notEqual(put, undefined, '保存必须打到 /put')
    assert.deepEqual(JSON.parse(put.init.body), { sessionId: 's1', messageId: 'm1', text: '改写后的回答' })
    view.root.unmount()
  })

  test('编辑面板：已有改写时显示恢复原文，并能删掉它', async () => {
    const ctx = fakeContext()
    const registration = ctx.find('message-edit-dialog')
    const action = ctx.find('message-edit')
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      if (url.startsWith('/api/dsh-message-edit/list')) {
        return {
          status: 200,
          json: async () => ({
            ok: true,
            settings: { maxChars: 20000 },
            items: [{ messageId: 'm1', text: '上一版改写', version: 'v1', createdAt: 1, updatedAt: 2 }],
          }),
        }
      }
      return { status: 200, json: async () => ({ ok: true, removed: true }) }
    }
    const view = mount(registration, 's1', { useChat: selector => selector(chatWith('m1', '原始回答')) })
    // 等装载那一次 list 落进 store。
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    act(() => {
      action.entry.inject('s1').openEditor('m1')
    })

    assert.equal(document.querySelector('textarea.dsme-textarea').value, '上一版改写', '已有改写时预填的是改写版')
    const restoreButton = [...document.querySelectorAll('button.dsme-button')].find(button => button.textContent === COPY.zh['dialog.restore'])
    assert.notEqual(restoreButton, undefined, '已有改写才出现恢复原文')

    await act(async () => {
      restoreButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const del = calls.find(call => call.url === '/api/dsh-message-edit/delete')
    assert.notEqual(del, undefined, '恢复原文必须打到 /delete')
    assert.deepEqual(JSON.parse(del.init.body), { sessionId: 's1', messageId: 'm1' })
    assert.equal(registration.entry.inject('s1').hooks.editor.getSnapshot().open, false, '恢复成功后面板关掉')
    view.root.unmount()
  })

  test('面板不打开时什么都不画', () => {
    const ctx = fakeContext()
    const registration = ctx.find('message-edit-dialog')
    const view = mount(registration, 's1', { useChat: selector => selector(chatWith('m1')) })
    assert.equal(document.querySelector('.dsme-overlay'), null)
    view.root.unmount()
  })
}
