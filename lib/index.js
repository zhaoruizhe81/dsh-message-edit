/**
 * dsh-message-edit — 宿主半边。
 *
 * 三件事：
 *
 * 1. 把改写记录落到 `$DSH_HOME/message-edit/edits.json`（`EditStore`）。
 * 2. 给浏览器开四个 `/api/dsh-message-edit/*` 路由（`createRoutes`）。
 * 3. 在模型请求出站前，把被改写的消息换成改写后的文字（`rewriteMessages`）。
 *
 * ── 第 3 件为什么长这样 ───────────────────────────────────────────────
 *
 * dsh 的会话日志是只追加的事实源，模型看到的每一条都能从日志重放出来。这条
 * 纪律对"改写回答"意味着：**assistant 消息在模型可见层里不可替换**——它由
 * provider 流嵌入而成，surface 的 replace 明确拒绝它（`assistant/message` 不能
 * 带 sourceEventSeqs，于是永远满足不了替换的引用校验）。插件能写的只有
 * `system/user/tool/developer` 的替换，那会把说话人换成别人，角色扮演里等于
 * 让模型以为用户说了自己的台词。
 *
 * 第二条路（自己声明一个新事件类型 + 消息投影）对外部插件是封死的：
 * 持久化读路径只接受 `KNOWN_SESSION_EVENT_TYPES` 里的类型，除非事件信封带
 * `ignorable: true`，而 `Session.append()` 不提供那个标记——写下去，这个会话
 * 下次就打不开了。
 *
 * 所以改写落在请求边界上：日志照旧诚实（原始回答一个字节不动），改写是叠加在
 * 出站请求上的投影。代价与边界写在 README 的「为什么不动会话日志」一节。
 *
 * 实现上只有一处需要注意：`llm/stream` 的监听器拿到的是**深冻结**的请求对象，
 * 而且 waterfall 的 `next()` 不接受参数——想换掉请求内容，就得自己再发一次。
 * 因此监听器以 `prepend` 排在链首，命中改写时用改写后的请求重新 dispatch，
 * 用 WeakSet 保证每个请求只改写一次；链条因此只跑一遍（跑在有改写的请求上），
 * 没有二次计费、二次重试、二次检查点。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { EditStore } from './store.js'
import { rewriteMessages } from './rewrite.js'
import { createRoutes } from './routes.js'

/** 插件名（Cordis 身份）。 */
export const name = 'message-edit'

/**
 * 依赖：这是个 Web GUI 插件，没有 Web 宿主就不激活；`llm` 是它唯一要动的服务——
 * 没有可派发的模型运行时，改写就没有落点。
 */
export const inject = ['webServer', 'llm']

/** 默认配置。 */
export const DEFAULTS = {
  /** 总开关；false 时监听器与路由都不装。 */
  enabled: true,
  /** 改写是否真的进模型上下文；false＝只记录（纯标注）。 */
  rewriteInContext: true,
  /** 是否在对话流里插入改写卡。 */
  transcriptCard: true,
  /** 单条改写的长度上限。 */
  maxChars: 20000,
  /** 记录文件所在目录；默认 `$DSH_HOME/message-edit`。 */
  dataDir: undefined,
}

/**
 * YAML 里写的 `~/…` 不会经过 shell，得自己展开——配置文件里最自然的那种写法
 * 不能变成"相对当前目录的一个名叫 ~ 的文件夹"。
 * @param value - 配置里的路径字符串。
 * @returns 展开后的绝对路径。
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 归一化行配置：只认自己那几个字段，数值做范围裁剪，坏值退回默认。
 * @param raw - profile 的 `cordis.patch.yml` 里那一行 `config`。
 * @returns 完整配置。
 */
export function normalizeConfig(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const maxChars = Number(source.maxChars)
  return {
    enabled: source.enabled !== false,
    rewriteInContext: source.rewriteInContext !== false,
    transcriptCard: source.transcriptCard !== false,
    maxChars: Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULTS.maxChars,
    dataDir: typeof source.dataDir === 'string' && source.dataDir.trim() !== '' ? expandHome(source.dataDir.trim()) : undefined,
  }
}

/**
 * 宿主插件入口。
 * @param ctx - 插件上下文（插件卸载时注册的一切随 fiber 回收）。
 * @param rawConfig - 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = typeof ctx.logger === 'function' ? ctx.logger('dsh-message-edit') : undefined
  if (!config.enabled) {
    log?.info?.('已停用（enabled: false）')
    return
  }

  const store = new EditStore({
    maxChars: config.maxChars,
    ...(config.dataDir === undefined ? {} : { dir: config.dataDir }),
  })
  // 装载是异步的，但请求改写不能 await（监听器是同步的）：装好之前索引是空的，
  // 请求走原路。几毫秒的窗口换掉一个 await 的复杂度。
  void store.load()
  ctx.effect(() => () => { void store.flush() }, 'dsh-message-edit: store flush')

  /** 本地校验"这条消息真的存在"：会话是活的才查得到，查不到就不拦。 */
  const resolveMessage = (sessionId, messageId) => {
    const session = ctx.get?.('sessions')?.get?.(sessionId)
    if (session === undefined) return undefined
    const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : undefined
    if (!Array.isArray(messages)) return undefined
    return messages.some(message => message?.id !== undefined && String(message.id) === messageId)
  }

  ctx.effect(() => {
    const disposers = createRoutes({
      store,
      settings: config,
      resolveMessage,
    }).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-message-edit: /api routes')

  if (!config.rewriteInContext) {
    log?.info?.('改写只记录，不进模型上下文（rewriteInContext: false）')
  } else {
    const rewritten = new WeakSet()
    ctx.on('llm/stream', (options, next) => {
      if (rewritten.has(options)) return next()
      try {
        const sessionId = options?.sessionId
        if (sessionId === undefined || sessionId === null) return next()
        const edits = store.textIndex(String(sessionId))
        if (edits === undefined) return next()
        const messages = rewriteMessages(options.messages, edits)
        if (messages === undefined) return next()
        // 必须走 `ctx.get`：`ctx.llm` 这种属性访问只对**声明了 inject 的服务**成立，
        // 没声明时它安静地给 undefined——改写会一声不响地退化成"什么都没发生"。
        const runtime = ctx.get('llm')
        if (runtime === undefined || runtime === null || typeof runtime.stream !== 'function') return next()
        const request = { ...options, messages }
        rewritten.add(request)
        log?.debug?.('改写 %d 条消息后重新派发请求（会话 %s）', edits.size, String(sessionId))
        return runtime.stream.call(runtime, request)
      } catch (error) {
        log?.warn?.('改写失败，按原请求继续：%s', String(error?.message ?? error))
        return next()
      }
    }, { global: true, prepend: true })
  }

  log?.info?.('已就绪，记录文件 %s', store.file)
}
