/**
 * dsh-message-edit — 改写记录的持久化。
 *
 * 一条改写 = 「会话 + 消息 id → 这段文字」。它是插件自己的数据，不进会话日志：
 * 会话日志是消息的原始事实，改写是叠加在请求上的投影。理由写在 README 的
 * 「为什么不动会话日志」一节，这里只说形状。
 *
 * 文件：`$DSH_HOME/message-edit/edits.json`
 *
 *   { "version": 1, "sessions": { "<sessionId>": { "<messageId>": item } } }
 *
 * 读是宽容的（坏行丢掉、坏文件备份后重来），写是原子的（临时文件 + rename），
 * 并且串行化：同一时刻只有一次落盘在飞。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 落盘格式版本；将来改形状时用它做迁移判断。 */
export const STORE_VERSION = 1

/** 单条改写的默认长度上限（UTF-16 码元）。 */
export const DEFAULT_MAX_CHARS = 20000

/**
 * 解析插件数据目录。
 * @param env - 环境变量表（默认 `process.env`），认 `DSH_HOME`。
 * @returns `$DSH_HOME/message-edit`，没有 `DSH_HOME` 时退回 `~/.dsh/message-edit`。
 */
export function defaultDataDir(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const home = configured === '' ? join(homedir(), '.dsh') : configured
  return join(home, 'message-edit')
}

/** 一条改写记录。 */
export function createItem({ messageId, text, original, now, uuid }) {
  const stamp = now()
  return {
    messageId,
    text,
    ...(typeof original === 'string' && original !== '' ? { original } : {}),
    version: uuid(),
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/** 判断一个持久化读回来的对象像不像 item。 */
function isItem(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (typeof value.messageId !== 'string' || value.messageId === '') return false
  if (typeof value.text !== 'string') return false
  if (value.original !== undefined && typeof value.original !== 'string') return false
  if (typeof value.version !== 'string') return false
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) return false
  return true
}

/** 把从磁盘读到的任意值折成一份新状态；不可用的部分静默丢弃。 */
function normalizeState(raw) {
  const state = { version: STORE_VERSION, sessions: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return state
  const sessions = raw.sessions
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return state
  for (const [sessionId, bucket] of Object.entries(sessions)) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) continue
    const kept = {}
    for (const [messageId, item] of Object.entries(bucket)) {
      if (messageId === '' || !isItem(item)) continue
      kept[messageId] = {
        messageId,
        text: item.text,
        ...(item.original === undefined ? {} : { original: item.original }),
        version: item.version,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }
    }
    if (Object.keys(kept).length > 0) state.sessions[sessionId] = kept
  }
  return state
}

/**
 * 改写记录的读写门面。所有 mutator 都是异步的（等一次落盘），读取是同步的：
 * 请求改写发生在同步的 `llm/stream` 监听器里，必须拿到当前值，不能 await。
 */
export class EditStore {
  #dir
  #file
  #maxChars
  #now
  #uuid
  #state = { version: STORE_VERSION, sessions: {} }
  #loaded = false
  #loading
  #loadError
  #dirty = false
  #writing = Promise.resolve()
  #ops = Promise.resolve()
  #indexes = new Map()

  /**
   * @param options - 数据目录、长度上限与可注入的时钟/随机源（测试用）。
   */
  constructor({ dir = defaultDataDir(), maxChars = DEFAULT_MAX_CHARS, now = Date.now, uuid = randomUUID } = {}) {
    this.#dir = dir
    this.#file = join(dir, 'edits.json')
    this.#maxChars = maxChars
    this.#now = now
    this.#uuid = uuid
  }

  /** 数据文件的绝对路径。 */
  get file() {
    return this.#file
  }

  /** 单条改写的长度上限。 */
  get maxChars() {
    return this.#maxChars
  }

  /** 装载失败的原因（没有失败则为 undefined）。坏文件不会让插件停摆。 */
  get loadError() {
    return this.#loadError
  }

  /** 是否已经读过一次磁盘。 */
  get loaded() {
    return this.#loaded
  }

  /**
   * 读一次磁盘。重复调用拿到的是**同一个** promise——并发装载必须只有一次：
   * 两次读同一份文件、各自把结果写回 `#state`，后落地的那次会把夹在中间的
   * 写入抹掉。文件不存在、内容坏掉都退化成空状态。
   * @returns 装载完成。
   */
  load() {
    this.#loading ??= this.#loadOnce()
    return this.#loading
  }

  async #loadOnce() {
    try {
      const text = await readFile(this.#file, 'utf8')
      this.#state = normalizeState(JSON.parse(text))
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        this.#state = { version: STORE_VERSION, sessions: {} }
      } else if (error instanceof SyntaxError) {
        this.#loadError = `edits.json 不是合法 JSON：${error.message}`
        await this.#backupCorrupt()
      } else {
        this.#loadError = `读取 edits.json 失败：${String(error?.message ?? error)}`
      }
    }
    this.#loaded = true
  }

  /** 坏文件先改名留证，绝不覆盖用户数据。 */
  async #backupCorrupt() {
    try {
      await rename(this.#file, `${this.#file}.corrupt-${this.#now()}`)
    } catch {
      /* 备份失败也不阻止插件启动 */
    }
  }

  /** 一个会话的全部改写，按创建顺序返回。 */
  listItems(sessionId) {
    const bucket = this.#state.sessions[sessionId]
    if (bucket === undefined) return []
    return Object.values(bucket)
      .slice()
      .sort((a, b) => (a.createdAt === b.createdAt ? a.messageId.localeCompare(b.messageId) : a.createdAt - b.createdAt))
  }

  /** 一条改写，没有则 undefined。 */
  getItem(sessionId, messageId) {
    return this.#state.sessions[sessionId]?.[messageId]
  }

  /**
   * 请求改写用的索引：消息 id → 改写后的文字。
   * @param sessionId - 会话 id。
   * @returns 只读 Map；没有改写时为 undefined（调用方据此走零开销路径）。
   */
  textIndex(sessionId) {
    const cached = this.#indexes.get(sessionId)
    if (cached !== undefined) return cached.size === 0 ? undefined : cached
    const bucket = this.#state.sessions[sessionId]
    if (bucket === undefined) return undefined
    const index = new Map()
    for (const item of Object.values(bucket)) index.set(item.messageId, item.text)
    this.#indexes.set(sessionId, index)
    return index.size === 0 ? undefined : index
  }

  /**
   * 新增或覆盖一条改写。同一 (会话, 消息) 只保留一条：保留最初的 createdAt，
   * 换一个 version——客户端靠它判断自己的视图是不是过期了。
   * @param request - 会话、消息、改写文字与可选的原文快照。
   * @returns 落盘后的记录，或一个失败码。
   */
  put(request) {
    return this.#enqueue(() => this.#put(request))
  }

  async #put({ sessionId, messageId, text, original }) {
    // 写之前先确保读过盘：装载是异步的，抢在它前面写会被它读回来的旧状态覆盖。
    await this.load()
    const invalid = validateTarget(sessionId, messageId)
    if (invalid !== undefined) return { ok: false, error: invalid }
    if (typeof text !== 'string') return { ok: false, error: { code: 'invalid-text', message: 'text 必须是字符串' } }
    if (text.length > this.#maxChars) {
      return { ok: false, error: { code: 'text-too-large', message: `改写最多 ${this.#maxChars} 个字符` } }
    }
    if (text.trim() === '') {
      // 直接调内部版本：公开的 remove 会再排一次队，而队列正等着这次任务收尾。
      await this.#remove(sessionId, messageId)
      return { ok: true, item: null }
    }

    const previous = this.getItem(sessionId, messageId)
    const keptOriginal = typeof original === 'string' && original !== ''
      ? original
      : previous?.original
    const item = {
      messageId,
      text,
      ...(keptOriginal === undefined ? {} : { original: keptOriginal }),
      version: this.#uuid(),
      createdAt: previous?.createdAt ?? this.#now(),
      updatedAt: this.#now(),
    }
    const bucket = this.#state.sessions[sessionId] ?? (this.#state.sessions[sessionId] = {})
    bucket[messageId] = item
    this.#invalidate(sessionId)
    await this.#flush()
    return { ok: true, item }
  }

  /**
   * 删掉一条改写（＝恢复原文）。
   * @param sessionId - 会话 id。
   * @param messageId - 消息 id。
   * @returns 落盘后的结果；删掉一条不存在的记录也算成功。
   */
  remove(sessionId, messageId) {
    return this.#enqueue(() => this.#remove(sessionId, messageId))
  }

  async #remove(sessionId, messageId) {
    await this.load()
    const invalid = validateTarget(sessionId, messageId)
    if (invalid !== undefined) return { ok: false, error: invalid }
    const bucket = this.#state.sessions[sessionId]
    if (bucket === undefined || bucket[messageId] === undefined) {
      return { ok: true, removed: false }
    }
    delete bucket[messageId]
    if (Object.keys(bucket).length === 0) delete this.#state.sessions[sessionId]
    this.#invalidate(sessionId)
    await this.#flush()
    return { ok: true, removed: true }
  }

  /**
   * 等到这一刻为止排进来的所有写操作都落了盘（测试与卸载路径用）。
   * 队列里的写也会被等到，不只是已经在飞的那一次。
   */
  async flush() {
    await this.#ops
    await this.#flush()
  }

  /** 把一次写操作排进串行队列：同一时刻只有一个 mutator 在跑。 */
  #enqueue(task) {
    const run = this.#ops.then(task, task)
    this.#ops = run.then(() => undefined, () => undefined)
    return run
  }

  #invalidate(sessionId) {
    this.#indexes.delete(sessionId)
    this.#dirty = true
  }

  #flush() {
    if (!this.#dirty) return this.#writing
    this.#dirty = false
    const payload = JSON.stringify(this.#state, null, 2)
    const file = this.#file
    const dir = this.#dir
    const temp = `${file}.${this.#uuid()}.tmp`
    this.#writing = this.#writing
      .then(async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(temp, payload, 'utf8')
        await rename(temp, file)
      })
      .catch((error) => {
        this.#loadError = `写入 edits.json 失败：${String(error?.message ?? error)}`
      })
    return this.#writing
  }
}

/** 目标校验：两个 id 都必须是非空、短小的字符串。 */
export function validateTarget(sessionId, messageId) {
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) {
    return { code: 'invalid-session', message: 'sessionId 必须是长度 1..200 的字符串' }
  }
  if (typeof messageId !== 'string' || messageId === '' || messageId.length > 200) {
    return { code: 'invalid-target', message: 'messageId 必须是长度 1..200 的字符串' }
  }
  return undefined
}
