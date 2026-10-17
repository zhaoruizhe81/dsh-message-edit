/**
 * EditStore：记录库的形状、落盘、以及"坏文件不许连累插件"。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { DEFAULT_MAX_CHARS, EditStore, STORE_VERSION, defaultDataDir, validateTarget } from '../lib/store.js'

async function storeWith(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-'))
  const store = new EditStore({ dir, uuid: options.uuid ?? (() => `v${Math.random().toString(36).slice(2)}`), now: options.now, ...options })
  await store.load()
  return store
}

test('defaultDataDir 认 DSH_HOME，缺省退回 ~/.dsh', () => {
  assert.equal(defaultDataDir({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/message-edit')
  assert.ok(defaultDataDir({}).endsWith('/.dsh/message-edit'))
  assert.ok(defaultDataDir({ DSH_HOME: '   ' }).endsWith('/.dsh/message-edit'))
})

test('validateTarget 拦住空 id 与超长 id', () => {
  assert.equal(validateTarget('s', 'm'), undefined)
  assert.equal(validateTarget('', 'm').code, 'invalid-session')
  assert.equal(validateTarget('s', '').code, 'invalid-target')
  assert.equal(validateTarget('s', 'x'.repeat(201)).code, 'invalid-target')
})

test('put 写入一条记录，list/get/textIndex 都看得到', async () => {
  const store = await storeWith()
  const result = await store.put({ sessionId: 's1', messageId: 'm1', text: '改写后的回答', original: '原始回答' })
  assert.equal(result.ok, true)
  assert.equal(result.item.messageId, 'm1')
  assert.equal(result.item.original, '原始回答')
  assert.equal(result.item.createdAt, result.item.updatedAt)

  const items = store.listItems('s1')
  assert.equal(items.length, 1)
  assert.equal(items[0].text, '改写后的回答')
  assert.equal(store.getItem('s1', 'm1').text, '改写后的回答')

  const index = store.textIndex('s1')
  assert.equal(index.get('m1'), '改写后的回答')
  assert.equal(store.textIndex('别的会话'), undefined)
})

test('同一条消息只留一条记录：createdAt 不动，version 换新', async () => {
  let version = 0
  const store = await storeWith({ uuid: () => `v${version += 1}`, now: () => 1000 })
  const first = await store.put({ sessionId: 's', messageId: 'm', text: '第一版' })
  const second = await store.put({ sessionId: 's', messageId: 'm', text: '第二版' })
  assert.equal(store.listItems('s').length, 1)
  assert.equal(second.item.text, '第二版')
  assert.equal(second.item.createdAt, first.item.createdAt)
  assert.notEqual(second.item.version, first.item.version)
})

test('第二次改写没带 original 时保留第一次的原文快照', async () => {
  const store = await storeWith()
  await store.put({ sessionId: 's', messageId: 'm', text: '第一版', original: '原始' })
  const second = await store.put({ sessionId: 's', messageId: 'm', text: '第二版' })
  assert.equal(second.item.original, '原始')
})

test('空文字等于删除，并且不是失败', async () => {
  const store = await storeWith()
  await store.put({ sessionId: 's', messageId: 'm', text: '有内容' })
  const result = await store.put({ sessionId: 's', messageId: 'm', text: '   \n ' })
  assert.equal(result.ok, true)
  assert.equal(result.item, null)
  assert.equal(store.getItem('s', 'm'), undefined)
})

test('remove 删一条，删不存在的也算成功', async () => {
  const store = await storeWith()
  await store.put({ sessionId: 's', messageId: 'm', text: 'x' })
  assert.deepEqual(await store.remove('s', 'm'), { ok: true, removed: true })
  assert.deepEqual(await store.remove('s', 'm'), { ok: true, removed: false })
  assert.equal(store.textIndex('s'), undefined)
})

test('超过 maxChars 的改写被拒，且不落盘', async () => {
  const store = await storeWith({ maxChars: 8 })
  const result = await store.put({ sessionId: 's', messageId: 'm', text: 'x'.repeat(9) })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'text-too-large')
  assert.equal(store.listItems('s').length, 0)
})

test('default maxChars 是 20000', async () => {
  const store = await storeWith()
  assert.equal(store.maxChars, DEFAULT_MAX_CHARS)
  assert.equal((await store.put({ sessionId: 's', messageId: 'm', text: 'x'.repeat(DEFAULT_MAX_CHARS + 1) })).ok, false)
})

test('并发装载只读一次盘：抢在装载前写的那条不会被读回来的旧状态抹掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-'))
  const store = new EditStore({ dir })
  // 故意不 await load()：模拟宿主 apply() 里的 `void store.load()`。
  const loading = store.load()
  const put = store.put({ sessionId: 's', messageId: 'm', text: '抢跑的写入' })
  await loading
  await put
  assert.equal(store.getItem('s', 'm').text, '抢跑的写入')
  await store.flush()
  const raw = JSON.parse(await readFile(join(dir, 'edits.json'), 'utf8'))
  assert.equal(raw.sessions.s.m.text, '抢跑的写入')
})

test('落盘是原子的：文件始终是完整 JSON，重新装载读得回来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-'))
  const store = new EditStore({ dir })
  await store.load()
  await store.put({ sessionId: 's', messageId: 'm', text: '落盘内容' })
  await store.flush()

  const raw = JSON.parse(await readFile(join(dir, 'edits.json'), 'utf8'))
  assert.equal(raw.version, STORE_VERSION)
  assert.equal(raw.sessions.s.m.text, '落盘内容')

  const reopened = new EditStore({ dir })
  await reopened.load()
  assert.equal(reopened.getItem('s', 'm').text, '落盘内容')
})

test('文件不存在只是空状态，不是错误', async () => {
  const store = await storeWith()
  assert.equal(store.loaded, true)
  assert.equal(store.loadError, undefined)
  assert.deepEqual(store.listItems('s'), [])
})

test('坏 JSON 会被备份改名，插件照常启动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-'))
  const file = join(dir, 'edits.json')
  await writeFile(file, '{ 这不是 json', 'utf8')
  const store = new EditStore({ dir })
  await store.load()
  assert.equal(store.listItems('s').length, 0)
  assert.match(store.loadError, /不是合法 JSON/)
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(dir)
  assert.equal(files.some(name => name.startsWith('edits.json.corrupt-')), true)
})

test('读回来的记录缺字段就丢掉那一条，不丢整个文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-'))
  await writeFile(join(dir, 'edits.json'), JSON.stringify({
    version: 1,
    sessions: {
      s: {
        good: { messageId: 'good', text: '好的', version: 'v', createdAt: 1, updatedAt: 2 },
        bad: { messageId: 'bad' },
        alsoBad: 42,
      },
      broken: 'not-an-object',
    },
  }), 'utf8')
  const store = new EditStore({ dir })
  await store.load()
  assert.deepEqual(store.listItems('s').map(item => item.messageId), ['good'])
  assert.deepEqual(store.listItems('broken'), [])
})

test('flush 等到最后一次落盘结束', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-'))
  const store = new EditStore({ dir })
  await store.load()
  void store.put({ sessionId: 's', messageId: 'm1', text: 'a' })
  await store.flush()
  const raw = JSON.parse(await readFile(join(dir, 'edits.json'), 'utf8'))
  assert.equal(raw.sessions.s.m1.text, 'a')
  after(() => {})
})
