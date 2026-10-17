/**
 * 请求改写：只换正文、保住身份与结构，不成立就不动。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { messageText, replaceMessageText, rewriteMessages } from '../lib/rewrite.js'

/** 一条像模像样的 assistant 消息（id / content / source 三件套）。 */
function assistant(id, blocks, source = { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }) {
  return { id, role: 'assistant', content: blocks, source }
}

test('messageText 只取文本块', () => {
  assert.equal(messageText(assistant('m1', [
    { type: 'reasoning', text: '想了想' },
    { type: 'text', text: '你' },
    { type: 'text', text: '好' },
  ])), '你好')
  assert.equal(messageText({ id: 'x', content: undefined }), '')
})

test('replaceMessageText 换掉正文，保留非文本块与全部身份字段', () => {
  const original = assistant('m1', [
    { type: 'reasoning', text: '推理' },
    { type: 'text', text: '旧回答' },
    { type: 'image', attachment: { id: 'a' } },
  ])
  const next = replaceMessageText(original, '新回答')
  assert.equal(next.id, 'm1')
  assert.equal(next.role, 'assistant')
  assert.equal(next.source.provider, 'deepseek')
  assert.deepEqual(next.content, [
    { type: 'reasoning', text: '推理' },
    { type: 'text', text: '新回答' },
    { type: 'image', attachment: { id: 'a' } },
  ])
  // 原消息一个字节没动。
  assert.equal(original.content[1].text, '旧回答')
})

test('多个文本块被这一条改写吸收成一段', () => {
  const next = replaceMessageText(assistant('m1', [
    { type: 'text', text: 'a' },
    { type: 'reasoning', text: 'r' },
    { type: 'text', text: 'b' },
  ]), '合并后的正文')
  assert.deepEqual(next.content, [
    { type: 'text', text: '合并后的正文' },
    { type: 'reasoning', text: 'r' },
  ])
})

test('改写丢掉 replayState，避免适配器按旧响应复述原文字', () => {
  const next = replaceMessageText(
    assistant('m1', [{ type: 'text', text: '旧' }], { kind: 'model', provider: 'p', model: 'm', replayState: { secret: 1 } }),
    '新',
  )
  assert.deepEqual(next.source, { kind: 'model', provider: 'p', model: 'm' })
})

test('没有文本块就改不了，返回 undefined', () => {
  assert.equal(replaceMessageText(assistant('m1', [{ type: 'reasoning', text: '只有推理' }]), '新'), undefined)
  assert.equal(replaceMessageText({ id: 'm', content: [] }, '新'), undefined)
})

test('改写结果被冻结（和日志里的消息同一种待遇）', () => {
  const next = replaceMessageText(assistant('m1', [{ type: 'text', text: '旧' }]), '新')
  assert.equal(Object.isFrozen(next), true)
  assert.equal(Object.isFrozen(next.content), true)
  assert.equal(Object.isFrozen(next.content[0]), true)
})

test('rewriteMessages 按 id 命中，其余消息原引用不动', () => {
  const system = { id: 'sys', role: 'system', content: [{ type: 'text', text: '提示词' }], source: { kind: 'system-prompt' } }
  const user = { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }
  const reply = assistant('a1', [{ type: 'text', text: '旧回答' }])
  const messages = [system, user, reply]
  const next = rewriteMessages(messages, new Map([['a1', '新回答']]))

  assert.notEqual(next, undefined)
  assert.equal(next[0], system)
  assert.equal(next[1], user)
  assert.equal(messageText(next[2]), '新回答')
  assert.equal(messageText(messages[2]), '旧回答')
  assert.equal(Object.isFrozen(next), true)
})

test('没有命中、没有索引、索引为空 —— 一律返回 undefined', () => {
  const messages = [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'model' } }]
  assert.equal(rewriteMessages(messages, new Map([['别的 id', 'y']])), undefined)
  assert.equal(rewriteMessages(messages, new Map()), undefined)
  assert.equal(rewriteMessages(messages, undefined), undefined)
  assert.equal(rewriteMessages(undefined, new Map([['a1', 'y']])), undefined)
})

test('id 不是字符串也能对上（品牌字符串与普通字符串同源）', () => {
  const messages = [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'model' } }]
  const next = rewriteMessages(messages, new Map([['a1', 'y']]))
  assert.equal(messageText(next[0]), 'y')
})

test('用户消息同样可改写（库对角色不设限）', () => {
  const user = { id: 'u1', role: 'user', content: [{ type: 'text', text: '我说的话' }], source: { kind: 'user' } }
  const next = rewriteMessages([user], new Map([['u1', '我说的话（改过）']]))
  assert.equal(messageText(next[0]), '我说的话（改过）')
  assert.equal(next[0].role, 'user')
})
