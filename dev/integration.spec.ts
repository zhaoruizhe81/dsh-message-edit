/**
 * 端到端：把 dsh-message-edit 的宿主半边挂进一个真的 AgentLoop 组合里，跑两个回合，
 * 看第二个回合的请求里那条消息到底是什么文字。
 *
 * 这是插件唯一没法用单元测试代替的那一步——"改写到底进没进模型上下文"。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import * as messageEdit from './message-edit-lib/index.js'

class FakeResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  payload: string | undefined

  setHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = value
  }

  end(payload: string): void {
    this.payload = payload
  }

  get json(): any {
    return JSON.parse(this.payload ?? '{}')
  }
}

function fakeRequest(init: { method?: string; url?: string; body?: unknown } = {}) {
  const chunks = init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))]
  return {
    method: init.method ?? 'GET',
    url: init.url ?? '/',
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 组装一个真组合：LLM + 会话 + agent loop + 本插件（webServer 用桩收路由）。 */
async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'message-edit-e2e-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)

  const routes: Array<{ path: string; handler: (req: any, res: any) => unknown }> = []
  ctx.provide('webServer', {
    register: (route: any) => {
      routes.push(route)
      return () => {}
    },
  })
  await ctx.plugin(
    { name: messageEdit.name, inject: messageEdit.inject, apply: messageEdit.apply },
    { dataDir },
  )

  const adapter = new MockAdapter([textResponse('第一条回答'), textResponse('第二条回答')])
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })

  const call = async (path: string, request: unknown) => {
    const route = routes.find(candidate => candidate.path === path)
    expect(route, `route ${path} must be registered`).toBeDefined()
    const res = new FakeResponse()
    await route!.handler(request as any, res as any)
    return res
  }

  return { ctx, adapter, call, dataDir }
}

it('改写一条助手回答之后，下一轮请求里模型读到的是改写版', async () => {
  const { ctx, adapter, call } = await harness()
  const agent = await ctx.agentLoop.create(SessionId('message-edit-e2e'), { provider: 'mock', model: 'mock' })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const assistant = agent.session.deriveMessages().find(message => message.role === 'assistant')
  expect(assistant).toBeDefined()
  expect(adapter.requests).toHaveLength(1)
  // 第一个请求发生在回答之前，里面只有系统提示与用户那句。
  expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('第一条回答')

  const put = await call('/api/dsh-message-edit/put', fakeRequest({
    method: 'POST',
    body: { sessionId: String(agent.session.id), messageId: String(assistant!.id), text: '你好啊宝宝' },
  }))
  expect(put.json.ok).toBe(true)

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '你刚刚回答的内容是什么' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(adapter.requests).toHaveLength(2)
  const second = adapter.requests[1]!
  const seen = second.messages.find(message => message.id === assistant!.id)
  expect(seen, '改写后的请求里必须还有这条消息').toBeDefined()
  expect(seen!.role).toBe('assistant')
  expect(seen!.content).toEqual([{ type: 'text', text: '你好啊宝宝' }])
  // 原始文字不许再出现在请求里。
  expect(JSON.stringify(second.messages)).not.toContain('第一条回答')

  // 会话日志本身没被改：原文还在，改写只是请求侧的投影。
  const logged = agent.session.deriveMessages().find(message => message.id === assistant!.id)
  expect(JSON.stringify(logged?.content)).toContain('第一条回答')

  await ctx.fiber.dispose()
})

it('没有改写的会话：请求里的消息与日志派生结果逐字节一致', async () => {
  const { ctx, adapter } = await harness()
  const agent = await ctx.agentLoop.create(SessionId('message-edit-clean'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const before = agent.session.deriveMessages()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '再来一句' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const second = adapter.requests[1]!
  // 没命中改写时监听器原样放行：请求里的历史前缀与派生结果**逐引用**相同，
  // 一个字节没动（新进来的那条用户消息接在最后）。
  expect(second.messages.length).toBe(before.length + 1)
  expect(before.every((message, index) => message === second.messages[index])).toBe(true)
  await ctx.fiber.dispose()
})

it('恢复原文后，请求回到原始文字', async () => {
  const { ctx, adapter, call } = await harness()
  const agent = await ctx.agentLoop.create(SessionId('message-edit-restore'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const assistant = agent.session.deriveMessages().find(message => message.role === 'assistant')!

  await call('/api/dsh-message-edit/put', fakeRequest({
    method: 'POST',
    body: { sessionId: String(agent.session.id), messageId: String(assistant.id), text: '改过的' },
  }))
  await call('/api/dsh-message-edit/delete', fakeRequest({
    method: 'POST',
    body: { sessionId: String(agent.session.id), messageId: String(assistant.id) },
  }))

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '再问一次' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const second = adapter.requests[1]!
  expect(JSON.stringify(second.messages)).toContain('第一条回答')
  expect(JSON.stringify(second.messages)).not.toContain('改过的')
  await ctx.fiber.dispose()
})
