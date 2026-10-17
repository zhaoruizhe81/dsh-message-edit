/**
 * dsh-message-edit — 请求改写。
 *
 * 这里只做一件事：拿一条已经组装好的模型请求（`GenerateOptions.messages`），
 * 把被改写过的消息换成改写后的文字，别的字节一个不动。
 *
 * 三条纪律：
 *
 * 1. **只换内容，不换身份。** 消息 id、role、非文本块（工具调用、图片、推理块）
 *    全部原样保留——它们在会话里的位置和语义不因改写而变。
 * 2. **丢掉 replayState。** assistant 消息的 `source.replayState` 是适配器用来
 *    复述原始响应的私货；留着它，改写会被适配器绕过（它按 replayState 重建原
 *    文字）。改写一条消息＝放弃这条消息的复述加成，这是改写的定义，不是损失。
 * 3. **不成立就不动。** 找不到文本块、没有命中、没有改写记录——一律返回
 *    undefined，调用方继续走原始请求，路径上不留痕迹。
 */

/** 深冻结：改写出来的消息与日志里的消息享受同一种不可变待遇。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return value
  }
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

/** 抽出消息里所有文本块的正文（推理块不算，它不面向用户）。 */
export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** 去掉 assistant 消息的复述状态，保留 provider/model。 */
function stripReplay(source) {
  if (typeof source !== 'object' || source === null) return undefined
  if (source.replayState === undefined) return undefined
  const { replayState: _dropped, ...rest } = source
  return rest
}

/**
 * 把一条消息的正文换成 `text`。
 * @param message - 原消息（来自 `session.deriveMessages()`，通常是冻结的）。
 * @param text - 改写后的正文。
 * @returns 冻结的新消息；消息里没有文本块时返回 undefined（无从改写）。
 */
export function replaceMessageText(message, text) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const first = blocks.findIndex(block => block !== null && typeof block === 'object' && block.type === 'text')
  if (first === -1) return undefined
  const content = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (index === first) {
      content.push({ ...block, text })
      continue
    }
    // 其余文本块被这一条改写吸收掉；非文本块原地保留。
    if (block !== null && typeof block === 'object' && block.type === 'text') continue
    content.push(block)
  }
  const source = stripReplay(message.source)
  const next = { ...message, content }
  if (source !== undefined) next.source = source
  return deepFreeze(next)
}

/**
 * 按改写索引重写整个消息数组。
 * @param messages - 请求里的消息数组（有序、通常冻结）。
 * @param edits - 消息 id → 改写后的正文。
 * @returns 冻结的新数组；没有任何一条被改时返回 undefined。
 */
export function rewriteMessages(messages, edits) {
  if (!Array.isArray(messages)) return undefined
  if (!(edits instanceof Map) || edits.size === 0) return undefined
  let changed = false
  const next = messages.map((message) => {
    const id = message?.id === undefined || message.id === null ? undefined : String(message.id)
    if (id === undefined) return message
    const text = edits.get(id)
    if (text === undefined) return message
    const rewritten = replaceMessageText(message, text)
    if (rewritten === undefined) return message
    changed = true
    return rewritten
  })
  return changed ? Object.freeze(next) : undefined
}
