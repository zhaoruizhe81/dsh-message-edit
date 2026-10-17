/**
 * 本机诊断：对一个**正在运行**的 dsh 宿主问四件事。
 *
 *   1. 客户端模块图里有没有 `dsh-message-edit` 这一行（profile 的 reconcile 认没认）；
 *   2. `/plugins/…/client.js` 取回来的字节是不是本地这一份（HMR 有没有在供码）；
 *   3. 宿主半边的 `/api/dsh-message-edit/status` 通不通（路由装没装上）；
 *   4. 写一条、读回来、再删掉（记录库与校验都跑通）。
 *
 * 浏览器凭据是一枚绑定了 authority 的签名 cookie（宿主那边 `browser-auth.ts`），
 * 签名密钥放在本机凭据库 `~/.dsh/.credentials.yaml` 里。这个脚本读它、现签一枚
 * 一小时后过期的 cookie，走一次和自己浏览器完全相同的取数路径——密钥只在内存里
 * 过一遍，不打印、不落盘。
 *
 *   node dev/probe.mjs                        # 默认 127.0.0.1:19387
 *   node dev/probe.mjs 127.0.0.1:19387
 */

import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const authority = process.argv[2] ?? '127.0.0.1:19387'
const pluginId = 'dsh-message-edit'
const localClient = new URL('../lib/client.js', import.meta.url).pathname
const base = `http://${authority}`

/** base64url，和宿主那边的 `encodeBase64Url` 同一套字母表。 */
const b64url = (buffer) => buffer.toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

const credentials = readFileSync(`${process.env.HOME}/.dsh/.credentials.yaml`, 'utf8')
const at = credentials.indexOf('client-connection/browser-session:')
if (at < 0) throw new Error('client-connection/browser-session record not found')
const secret = /secret:\s*([A-Za-z0-9_-]+)/.exec(credentials.slice(at))?.[1]
if (secret === undefined) throw new Error('secret field not found')

const now = Date.now()
const body = b64url(Buffer.from(JSON.stringify({
  version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000,
}), 'utf8'))
const cookie = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
  + `=v1.${body}.${b64url(createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest())}`

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── 1/2. 客户端模块图与字节
const index = await fetch(`${base}/`, { headers: { cookie } })
const html = await index.text()
check('GET / 返回 Web shell', index.status === 200, `HTTP ${index.status} · ${html.length} bytes`)

const boot = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html)
check('shell 里带着启动图', boot !== null)
let entry
if (boot !== null) {
  const graph = JSON.parse(boot[1].replaceAll('\\u003c', '<'))
  entry = graph.entries.find(row => row.id === pluginId)
  check(`模块图里有 ${pluginId} 这一行`, entry !== undefined, `graph rev ${graph.rev} · ${graph.entries.length} rows`)
  if (entry !== undefined) {
    const url = `${base}/${entry.url.replace(/^\.?\//u, '')}`
    const res = await fetch(url, { headers: { cookie } })
    const served = await res.text()
    const local = readFileSync(localClient, 'utf8')
    // 宿主会在组合脚本尾部接一行 `//# sourceMappingURL=…`，所以按前缀比。
    check('取回的 bundle 就是本地这一份', res.status === 200 && served.startsWith(local.trimEnd()), `HTTP ${res.status} · ${served.length} bytes`)
  }
}

// ── 3. 宿主路由
const api = `${base}/api/dsh-message-edit`
const status = await fetch(`${api}/status`, { headers: { cookie } })
const statusBody = await status.json().catch(() => undefined)
check('宿主路由 /status 通', status.status === 200 && statusBody?.ok === true, JSON.stringify(statusBody))

// ── 4. 写一条、读回来、删掉
const probeSession = `probe-session-${now}`
const probeMessage = `probe-message-${now}`
const put = await fetch(`${api}/put`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: probeSession, messageId: probeMessage, text: '探测改写', original: '探测原文' }),
})
const putBody = await put.json().catch(() => undefined)
check('写入一条改写', put.status === 200 && putBody?.ok === true, JSON.stringify(putBody))

const list = await fetch(`${api}/list?sessionId=${encodeURIComponent(probeSession)}`, { headers: { cookie } })
const listBody = await list.json().catch(() => undefined)
check('读回这条改写', listBody?.items?.length === 1 && listBody.items[0].text === '探测改写', JSON.stringify(listBody))

const del = await fetch(`${api}/delete`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: probeSession, messageId: probeMessage }),
})
const delBody = await del.json().catch(() => undefined)
check('删掉这条改写', delBody?.ok === true && delBody.removed === true, JSON.stringify(delBody))

const after = await fetch(`${api}/list?sessionId=${encodeURIComponent(probeSession)}`, { headers: { cookie } })
const afterBody = await after.json().catch(() => undefined)
check('删干净了，空会话不留痕', Array.isArray(afterBody?.items) && afterBody.items.length === 0, JSON.stringify(afterBody))

process.exit(failures === 0 ? 0 : 1)
