/**
 * dsh-message-edit — 浏览器半边与宿主半边之间的那条 HTTP 线。
 *
 * 为什么不用 Remote（typert）：那条路要在构建期从 TS 类型里生成描述符，本插件
 * 是零构建的手写包。为什么走 `/api/*`：宿主自己那枚签名 cookie 是绑在
 * /api 前缀的浏览器凭据，同源 fetch 自动带上，跨标签页、跨刷新都还在。
 *
 * 四个路由都在 `/api/dsh-message-edit` 下，全部返回 JSON，全部 no-store：
 *
 *   GET  /status                  宿主状态（诊断用：是否启用、上限、条数）
 *   GET  /list?sessionId=…        这个会话现有的改写
 *   POST /put                     写入一条改写（空文字＝删除）
 *   POST /delete                  删掉一条改写（恢复原文）
 */

import { validateTarget } from './store.js'

/** 路由前缀。改它会同时改掉客户端那一半，别改。 */
export const API_BASE = '/api/dsh-message-edit'

/** 请求体上限：一条改写最多几十 KB，1 MiB 是余量。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 统一的 JSON 回应。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(payload))
  res.end(payload)
}

/** 业务失败。 */
function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** 读一个 JSON 请求体，超限即拒绝。 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return { ok: false, error: { code: 'body-too-large', message: '请求体过大' } }
    chunks.push(chunk)
  }
  if (size === 0) return { ok: true, value: {} }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: { code: 'invalid-body', message: '请求体必须是 JSON 对象' } }
    }
    return { ok: true, value }
  } catch {
    return { ok: false, error: { code: 'invalid-body', message: '请求体不是合法 JSON' } }
  }
}

/**
 * 对外的 item 形状。原文（`original`）也发：面板里的"原始回答"对照因此不依赖
 * 那条消息还在不在客户端的渲染窗口里。
 */
function publicItem(item) {
  return {
    messageId: item.messageId,
    text: item.text,
    ...(item.original === undefined ? {} : { original: item.original }),
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

/**
 * 组装全部路由。
 * @param options - 记录库、对外设置、以及可选的「这条消息真的存在吗」校验。
 * @returns `ctx.webServer.register()` 直接吃的路由数组。
 */
export function createRoutes({ store, settings = {}, resolveMessage } = {}) {
  const settingsView = () => ({
    enabled: settings.enabled !== false,
    rewriteInContext: settings.rewriteInContext !== false,
    transcriptCard: settings.transcriptCard !== false,
    maxChars: store.maxChars,
  })

  /** 目标校验：本地能查到会话时，消息必须真的存在（拦截拼错的 id）。 */
  const targetExists = (sessionId, messageId) => {
    if (typeof resolveMessage !== 'function') return undefined
    try {
      return resolveMessage(sessionId, messageId)
    } catch {
      return undefined
    }
  }

  const handleStatus = (req, res) => {
    if (req.method !== 'GET') return fail(res, 405, 'method-not-allowed', '只接受 GET')
    sendJson(res, 200, { ok: true, settings: settingsView() })
  }

  const handleList = (req, res) => {
    if (req.method !== 'GET') return fail(res, 405, 'method-not-allowed', '只接受 GET')
    const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
    if (sessionId === '') return fail(res, 400, 'invalid-session', '缺少 sessionId')
    sendJson(res, 200, {
      ok: true,
      settings: settingsView(),
      items: store.listItems(sessionId).map(publicItem),
    })
  }

  const handlePut = async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', '只接受 POST')
    const parsed = await readJson(req)
    if (!parsed.ok) return fail(res, 400, parsed.error.code, parsed.error.message)
    const { sessionId, messageId, text, original } = parsed.value
    const invalid = validateTarget(sessionId, messageId)
    if (invalid !== undefined) return fail(res, 400, invalid.code, invalid.message)
    if (typeof text !== 'string') return fail(res, 400, 'invalid-text', 'text 必须是字符串')
    if (targetExists(sessionId, messageId) === false) {
      return fail(res, 404, 'target-not-found', '这个会话里没有这条消息')
    }
    const result = await store.put({ sessionId, messageId, text, original })
    if (!result.ok) {
      const status = result.error.code === 'text-too-large' ? 413 : 400
      return fail(res, status, result.error.code, result.error.message)
    }
    sendJson(res, 200, {
      ok: true,
      item: result.item === null ? null : publicItem(result.item),
    })
  }

  const handleDelete = async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', '只接受 POST')
    const parsed = await readJson(req)
    if (!parsed.ok) return fail(res, 400, parsed.error.code, parsed.error.message)
    const { sessionId, messageId } = parsed.value
    const invalid = validateTarget(sessionId, messageId)
    if (invalid !== undefined) return fail(res, 400, invalid.code, invalid.message)
    const result = await store.remove(sessionId, messageId)
    if (!result.ok) return fail(res, 400, result.error.code, result.error.message)
    sendJson(res, 200, { ok: true, removed: result.removed === true })
  }

  return [
    { kind: 'exact', path: `${API_BASE}/status`, handler: handleStatus },
    { kind: 'exact', path: `${API_BASE}/list`, handler: handleList },
    { kind: 'exact', path: `${API_BASE}/put`, handler: handlePut },
    { kind: 'exact', path: `${API_BASE}/delete`, handler: handleDelete },
  ]
}
