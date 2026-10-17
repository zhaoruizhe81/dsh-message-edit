/**
 * dsh-message-edit — 浏览器半边。
 *
 * 一句话：把「改写」这件事放回它该在的地方——那条回答自己的动作行里。
 *
 * 三块画面：
 *
 * 1. `conversation.chat.assistant-actions` 里一颗笔形按钮（每条定稿的 assistant
 *    消息一颗）。没改写是灰的，改写过是品牌色 + 一点标记。
 * 2. `conversation.chat.turnTail` 里一张改写卡：这一轮有哪些回答被改写了，
 *    改写后的文字直接铺在对话流里——用户想看到的就是这个版本，不是日志里的
 *    原版。改写卡是插件自己的画面，不碰别人的 DOM。
 * 3. `conversation.input.overlay` 里一个编辑面板：原文可折叠对照、保存、恢复原文。
 *
 * 数据从`/api/dsh-message-edit/*`来（同源 fetch，宿主那枚签名 cookie 自动带上）。
 * 每条会话一份 `EditSurface`：一份列表状态、一份编辑草稿，两个 slot 条目共用。
 *
 * 没有构建步骤：这个文件就是产物，形状与 rolldown 预设吐出的闭包工厂一致。
 * 只 require 平台种子表里的东西（React、react-dom），别的一概不 require——
 * 动态包会变，而这个文件不会跟着一起重建。
 */

window.__ModuleLoader__.load({
  id: 'dsh-message-edit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    //#region constants

    /** 包名：同时是模块表 id、样式标签的归属标记、locale 之外的诊断前缀。 */
    const PLUGIN_ID = 'dsh-message-edit'
    /** 本插件的 locale 命名空间。 */
    const NS = 'messageEdit'
    /** 宿主那一半的路由前缀。 */
    const API = '/api/dsh-message-edit'
    /** 本插件唯一一张样式表的身份。 */
    const STYLE_ID = PLUGIN_ID + '/client.css'
    /** 改写卡折叠时的行数（CSS 行夹）。 */
    const CLAMP_LINES = 8

    /** 两个 selector 共用的恒等比较：都是字符串，Object.is 就够。 */
    const sameText = (a, b) => a === b

    /** 文案。宿主中英双语，这里跟着走。 */
    const COPY = {
      zh: {
        'action.edit': '改写这条回答',
        'action.editHint': '觉得这条回答不好？直接改成你想要的样子，后续对话按改写版继续',
        'action.editActive': '已改写：点击编辑',
        'action.editActiveHint': '模型读到的是改写版；原始回答留在会话日志里',
        'card.badge': '已改写',
        'card.note': '模型从这条起读的是改写版，原始回答仍在日志里',
        'card.expand': '展开',
        'card.collapse': '收起',
        'card.open': '编辑',
        'dialog.title': '改写这条回答',
        'dialog.titleEdited': '编辑改写',
        'dialog.close': '关闭',
        'dialog.hint': '保存后，后续对话里模型读到的就是这段文字。原始回答不会被删掉，随时可以恢复。',
        'dialog.placeholder': '这条回答应该是什么样…',
        'dialog.original': '原始回答（只读）',
        'dialog.originalMissing': '这次读不到原始回答（可能已经翻页出内存）。不影响改写本身。',
        'dialog.restore': '恢复原文',
        'dialog.cancel': '取消',
        'dialog.save': '保存改写',
        'dialog.saving': '保存中…',
        'error.text-too-large': '改写太长了，最多 {max} 个字符',
        'error.target-not-found': '找不到这条消息（会话可能已经重新加载）',
        'error.host-unreachable': '连不上宿主，改写没保存',
        'error.host-bad-response': '宿主回了看不懂的内容',
        'error.invalid-session': '会话身份不对，改写没保存',
        'error.invalid-target': '消息身份不对，改写没保存',
        'error.invalid-text': '改写内容不对，改写没保存',
        'error.invalid-body': '请求内容不对，改写没保存',
        'error.body-too-large': '改写太长了，宿主没收',
        'error.method-not-allowed': '宿主不接受这种请求',
        'error.load': '改写列表没读出来',
        'error.generic': '保存失败，再试一次',
      },
      en: {
        'action.edit': 'Rewrite this reply',
        'action.editHint': 'Not happy with this reply? Write the version you wanted — later turns continue from it',
        'action.editActive': 'Rewritten — click to edit',
        'action.editActiveHint': 'The model reads your version; the original stays in the session log',
        'card.badge': 'Rewritten',
        'card.note': 'The model reads this version from here on; the original stays in the log',
        'card.expand': 'Expand',
        'card.collapse': 'Collapse',
        'card.open': 'Edit',
        'dialog.title': 'Rewrite this reply',
        'dialog.titleEdited': 'Edit the rewrite',
        'dialog.close': 'Close',
        'dialog.hint': 'After saving, the model reads this text in every later turn. The original reply is not deleted — you can restore it any time.',
        'dialog.placeholder': 'What should this reply have said…',
        'dialog.original': 'Original reply (read-only)',
        'dialog.originalMissing': 'The original text is not readable right now (it may be paged out). The rewrite still works.',
        'dialog.restore': 'Restore original',
        'dialog.cancel': 'Cancel',
        'dialog.save': 'Save rewrite',
        'dialog.saving': 'Saving…',
        'error.text-too-large': 'Too long — {max} characters at most',
        'error.target-not-found': 'That message is gone (the session may have reloaded)',
        'error.host-unreachable': 'Cannot reach the host — nothing was saved',
        'error.host-bad-response': 'The host answered something unreadable',
        'error.invalid-session': 'Wrong session identity — nothing was saved',
        'error.invalid-target': 'Wrong message identity — nothing was saved',
        'error.invalid-text': 'Wrong rewrite text — nothing was saved',
        'error.invalid-body': 'Wrong request body — nothing was saved',
        'error.body-too-large': 'Too long — the host refused it',
        'error.method-not-allowed': 'The host does not accept that request',
        'error.load': 'Could not load the rewrite list',
        'error.generic': 'Save failed — try again',
      },
    }

    //#endregion

    //#region pure helpers

    /** 一段 assistant 展示块里的正文（和宿主那套 copy 用的提取口径一致）。 */
    function assistantText(blocks) {
      if (!Array.isArray(blocks)) return ''
      return blocks
        .filter(block => block !== null && typeof block === 'object' && block.kind === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
    }

    /** 在 Chat 快照里按消息 id 找这条回答的正文；找不到返回空串。 */
    function messageTextOfSnapshot(snapshot, messageId) {
      if (snapshot === null || typeof snapshot !== 'object' || messageId === null || messageId === undefined) return ''
      const nodes = snapshot.nodes
      if (nodes === null || typeof nodes !== 'object' || typeof nodes.values !== 'function') return ''
      const wanted = String(messageId)
      for (const node of nodes.values()) {
        const finalNode = node?.data?.finalNode
        if (finalNode === undefined || finalNode === null) continue
        if (finalNode.messageId === undefined || String(finalNode.messageId) !== wanted) continue
        return assistantText(finalNode.blocks)
      }
      return ''
    }

    /**
     * 这一轮里被改写过的消息 id（按对话顺序，换行分隔的字符串）。
     * 返回字符串而不是数组：selector 的恒等比较只认引用，原语最省心。
     */
    function editedIdsInTurn(snapshot, turn, idsKey) {
      if (typeof idsKey !== 'string' || idsKey === '') return ''
      if (snapshot === null || typeof snapshot !== 'object') return ''
      const locations = snapshot.locations
      if (locations === null || typeof locations !== 'object' || typeof locations.getTurn !== 'function') return ''
      const keys = locations.getTurn(turn)
      if (!Array.isArray(keys)) return ''
      const nodes = snapshot.nodes
      const wanted = new Set(idsKey.split('\n'))
      const found = []
      for (const key of keys) {
        const node = nodes !== null && typeof nodes === 'object' && typeof nodes.get === 'function' ? nodes.get(key) : undefined
        const id = node?.data?.finalNode?.messageId
        if (id === undefined) continue
        const text = String(id)
        if (wanted.has(text)) found.push(text)
      }
      return found.join('\n')
    }

    /** 改写集合 → idsKey；只有 id、没有正文，正文变化不需要重算。 */
    function idsKeyOf(items) {
      if (!(items instanceof Map) || items.size === 0) return ''
      return [...items.keys()].map(String).sort().join('\n')
    }

    /**
     * 错误码 → 文案。宿主可能回一个新码（版本比客户端新），认不出就兜一句
     * 通用话，绝不把码本身端到用户面前。
     */
    function errorTextOf(t, code, maxChars) {
      const key = `error.${String(code)}`
      if (!Object.prototype.hasOwnProperty.call(COPY.zh, key)) return t('error.generic')
      return t(key, { max: maxChars })
    }

    //#endregion

    //#region store / api

    /**
     * 一个极小的快照源：`hooks` 要的就是 getSnapshot + subscribe，框架那边
     * 拿它合成 useXxx 选择器。状态整体替换，不做局部更新——一次改写就是一次
     * 新 Map，比较靠引用。
     */
    function createStore(init) {
      let state = init
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          if (Object.is(next, state)) return
          state = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[dsh-message-edit] subscriber failed:', error)
            }
          }
        },
      }
    }

    /** 一次 /api 调用。任何异常都折成 `{ ok:false, error:{ code } }`，不抛。 */
    async function callApi(path, init) {
      const hasBody = init !== undefined && init.body !== undefined
      try {
        const response = await fetch(`${API}${path}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...init,
          headers: {
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
            ...(init?.headers ?? {}),
          },
        })
        const body = await response.json().catch(() => undefined)
        if (body !== null && typeof body === 'object' && typeof body.ok === 'boolean') return body
        return { ok: false, error: { code: `http-${response.status}` } }
      } catch {
        return { ok: false, error: { code: 'host-unreachable' } }
      }
    }

    //#endregion

    //#region surface

    /** 一条会话的改写状态：列表 + 编辑草稿。两个 slot 条目共用一份。 */
    class EditSurface {
      constructor(sessionId) {
        this.sessionId = sessionId
        this.alive = true
        this.items = createStore({
          status: 'loading',
          items: new Map(),
          idsKey: '',
          settings: { transcriptCard: true, maxChars: 20000 },
        })
        this.editor = createStore({
          open: false,
          messageId: null,
          draft: null,
          saving: false,
          error: null,
        })
        void this.reload()
      }

      dispose() {
        this.alive = false
      }

      /** 拉一次这个会话的改写列表。失败只记状态，不打扰用户。 */
      async reload() {
        const result = await callApi(`/list?sessionId=${encodeURIComponent(this.sessionId)}`)
        if (!this.alive) return
        if (!result.ok) {
          this.items.set({ ...this.items.getSnapshot(), status: 'error' })
          return
        }
        const items = new Map()
        for (const item of Array.isArray(result.items) ? result.items : []) {
          if (typeof item?.messageId === 'string') items.set(item.messageId, item)
        }
        this.items.set({
          status: 'ready',
          items,
          idsKey: idsKeyOf(items),
          settings: {
            transcriptCard: result.settings?.transcriptCard !== false,
            maxChars: Number.isSafeInteger(result.settings?.maxChars) ? result.settings.maxChars : 20000,
          },
        })
      }

      /** 把一次写操作的结果折进列表。`item` 为 null 表示这条改写不存在了。 */
      applyItem(messageId, item) {
        const current = this.items.getSnapshot()
        const items = new Map(current.items)
        if (item === null || item === undefined) items.delete(messageId)
        else items.set(item.messageId, item)
        this.items.set({ ...current, status: 'ready', items, idsKey: idsKeyOf(items) })
      }

      openEditor(messageId) {
        this.editor.set({ open: true, messageId, draft: null, saving: false, error: null })
      }

      closeEditor() {
        this.editor.set({ open: false, messageId: null, draft: null, saving: false, error: null })
      }

      setDraft(draft) {
        this.editor.set({ ...this.editor.getSnapshot(), draft })
      }

      /** 保存当前草稿（`text` 由面板传入，避免草稿没落库时读到陈值）。 */
      async save(text) {
        const editor = this.editor.getSnapshot()
        if (editor.messageId === null || editor.saving) return
        this.editor.set({ ...editor, saving: true, error: null })
        const result = await callApi('/put', {
          method: 'POST',
          body: JSON.stringify({ sessionId: this.sessionId, messageId: editor.messageId, text }),
        })
        if (!this.alive) return
        if (!result.ok) {
          this.editor.set({ ...this.editor.getSnapshot(), saving: false, error: result.error?.code ?? 'generic' })
          return
        }
        this.applyItem(editor.messageId, result.item ?? null)
        this.closeEditor()
      }

      /** 恢复原文：删掉这条改写。 */
      async restore() {
        const editor = this.editor.getSnapshot()
        if (editor.messageId === null || editor.saving) return
        this.editor.set({ ...editor, saving: true, error: null })
        const result = await callApi('/delete', {
          method: 'POST',
          body: JSON.stringify({ sessionId: this.sessionId, messageId: editor.messageId }),
        })
        if (!this.alive) return
        if (!result.ok) {
          this.editor.set({ ...this.editor.getSnapshot(), saving: false, error: result.error?.code ?? 'generic' })
          return
        }
        this.applyItem(editor.messageId, null)
        this.closeEditor()
      }
    }

    //#endregion

    //#region components

    /** 笔形图标：与动作行里自带的图标同一种线宽与尺寸口径。 */
    function PenIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M15.4 3.6l5 5-11 11-5.6 1.6 1.6-5.6z' }),
        h('path', { d: 'M13.9 5.1l5 5' }),
      )
    }

    /** 每条定稿 assistant 消息的动作：改写 / 已改写。 */
    function EditAction({ messageId, useEdits, openEditor, t }) {
      const item = useEdits(view => view.items.get(messageId))
      const edited = item !== undefined
      const label = edited ? t('action.editActive') : t('action.edit')
      return h(
        'button',
        {
          type: 'button',
          className: 'dsme-action',
          'aria-label': label,
          title: edited ? t('action.editActiveHint') : t('action.editHint'),
          'data-edited': edited ? '' : undefined,
          onClick: () => openEditor(messageId),
        },
        PenIcon(),
        edited ? h('span', { className: 'dsme-dot', 'aria-hidden': 'true' }) : null,
      )
    }

    /** 一轮结束处的改写卡：把改写后的文字铺在对话流里。 */
    function RewriteCard({ turn, useChat, useEdits, openEditor, t }) {
      const idsKey = useEdits(view => view.idsKey)
      const items = useEdits(view => view.items)
      const showCard = useEdits(view => view.settings.transcriptCard)
      const edited = useChat(snapshot => editedIdsInTurn(snapshot, turn, idsKey), sameText)
      const [expanded, setExpanded] = useState(false)
      const toggle = useCallback(() => { setExpanded(value => !value) }, [])

      if (showCard === false || typeof edited !== 'string' || edited === '') return null
      const list = edited
        .split('\n')
        .map(id => items.get(id))
        .filter(item => item !== undefined)
      if (list.length === 0) return null
      const long = list.some(item => item.text.length > CLAMP_LINES * 42)
      return h(
        'div',
        { className: 'dsme-card', 'data-expanded': expanded ? '' : undefined },
        h(
          'div',
          { className: 'dsme-card-head' },
          h('span', { className: 'dsme-badge' }, t('card.badge')),
          h('span', { className: 'dsme-card-note' }, t('card.note')),
          h('span', { className: 'dsme-spacer' }),
          long ? h('button', { type: 'button', className: 'dsme-link', onClick: toggle }, expanded ? t('card.collapse') : t('card.expand')) : null,
          h('button', { type: 'button', className: 'dsme-link', onClick: () => { openEditor(list[0].messageId) } }, t('card.open')),
        ),
        list.map(item => h('div', { key: item.messageId, className: 'dsme-card-text' }, item.text)),
      )
    }

    /** 编辑面板：草稿、原文对照、保存/恢复/取消。 */
    function EditDialog({ sessionId, useChat, useEdits, useEditor, setDraft, save, restore, close, t }) {
      const editor = useEditor(view => view)
      const messageId = editor.messageId
      const item = useEdits(view => (messageId === null ? undefined : view.items.get(messageId)))
      const maxChars = useEdits(view => view.settings.maxChars)
      const live = useChat(snapshot => (messageId === null ? '' : messageTextOfSnapshot(snapshot, messageId)), sameText)
      const open = editor.open === true && messageId !== null
      const areaRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        const handle = window.setTimeout(() => { areaRef.current?.focus() }, 0)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          window.clearTimeout(handle)
        }
      }, [open, close])

      if (!open) return null
      const original = typeof item?.original === 'string' && item.original !== '' ? item.original : live
      const value = editor.draft !== null ? editor.draft : (item?.text ?? live)
      const errorText = editor.error === null ? null : errorTextOf(t, editor.error, maxChars)

      const panel = h(
        'div',
        {
          className: 'dsme-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': item === undefined ? t('dialog.title') : t('dialog.titleEdited'),
        },
        h(
          'div',
          { className: 'dsme-panel-head' },
          h('h2', { className: 'dsme-title' }, item === undefined ? t('dialog.title') : t('dialog.titleEdited')),
          h('button', { type: 'button', className: 'dsme-close', 'aria-label': t('dialog.close'), onClick: close }, '×'),
        ),
        h('p', { className: 'dsme-hint' }, t('dialog.hint')),
        h('textarea', {
          ref: areaRef,
          className: 'dsme-textarea',
          value,
          spellCheck: false,
          placeholder: t('dialog.placeholder'),
          onChange: event => setDraft(event.target.value),
          onKeyDown: (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void save(value)
            }
          },
        }),
        h(
          'details',
          { className: 'dsme-original' },
          h('summary', null, t('dialog.original')),
          h('pre', null, original === '' ? t('dialog.originalMissing') : original),
        ),
        errorText === null ? null : h('p', { className: 'dsme-error', role: 'alert' }, errorText),
        h(
          'div',
          { className: 'dsme-actions' },
          item === undefined
            ? null
            : h('button', { type: 'button', className: 'dsme-button', disabled: editor.saving, onClick: () => { void restore() } }, t('dialog.restore')),
          h('span', { className: 'dsme-spacer' }),
          h('button', { type: 'button', className: 'dsme-button', disabled: editor.saving, onClick: close }, t('dialog.cancel')),
          h(
            'button',
            {
              type: 'button',
              className: 'dsme-button dsme-primary',
              disabled: editor.saving || value.trim() === '',
              onClick: () => { void save(value) },
            },
            editor.saving ? t('dialog.saving') : t('dialog.save'),
          ),
        ),
      )
      return ReactDOM.createPortal(
        h(
          'div',
          {
            className: 'dsme-overlay',
            'data-session': sessionId,
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) close()
            },
          },
          panel,
        ),
        document.body,
      )
    }

    //#endregion

    //#region style

    const CSS = `
.dsme-action{display:inline-flex;align-items:center;justify-content:center;gap:2px;height:calc(28px + var(--dsh-content-font-delta,0px));min-width:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsme-action svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}
.dsme-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsme-action[data-edited]{color:var(--dsw-alias-state-business-primary)}
.dsme-action:focus-visible,.dsme-link:focus-visible,.dsme-button:focus-visible,.dsme-close:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsme-dot{width:4px;height:4px;margin-left:1px;border-radius:999px;background:currentColor;flex:none}
.dsme-card{box-sizing:border-box;margin:8px 0 2px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);min-width:0;max-width:100%}
.dsme-card-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
.dsme-badge{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-state-business-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-business-primary);font-weight:500}
.dsme-card-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsme-spacer{flex:1 1 auto}
.dsme-link{border:none;background:transparent;padding:0 2px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit}
.dsme-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.dsme-card-text{margin-top:6px;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:22px;white-space:pre-wrap;word-break:break-word}
.dsme-card:not([data-expanded]) .dsme-card-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${CLAMP_LINES};overflow:hidden}
.dsme-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dsme-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(680px,100%);max-height:100%;overflow:auto;padding:20px 24px 18px;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dsme-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsme-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsme-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:18px;line-height:1}
.dsme-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsme-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
.dsme-textarea{box-sizing:border-box;width:100%;min-height:160px;max-height:46vh;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;resize:vertical}
.dsme-textarea:focus{border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary);outline:none}
.dsme-original{border-radius:var(--dsw-radius-md)}
.dsme-original summary{cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsme-original pre{margin:6px 0 0;padding:10px 12px;max-height:200px;overflow:auto;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.dsme-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dsme-actions{display:flex;align-items:center;gap:8px}
.dsme-button{box-sizing:border-box;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.dsme-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsme-button:disabled{cursor:not-allowed;opacity:.4}
.dsme-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsme-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
@media (prefers-reduced-motion:reduce){.dsme-link{transition:none}}
`

    //#endregion

    //#region plugin

    /** 依赖：席位注册 + 文案。 */
    const inject = ['slots', 'locale']

    /**
     * 客户端插件主体：三个 slot 条目、一张样式表、一份字典，以及每条会话的状态面。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), 'dsh-message-edit: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = PLUGIN_ID
        style.dataset.pluginCss = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dsh-message-edit: stylesheet')

      const surfaces = new Map()
      const surfaceFor = (sessionId) => {
        let surface = surfaces.get(sessionId)
        if (surface === undefined) {
          surface = new EditSurface(sessionId)
          surfaces.set(sessionId, surface)
        }
        return surface
      }
      ctx.effect(() => () => {
        for (const surface of surfaces.values()) surface.dispose()
        surfaces.clear()
      }, 'dsh-message-edit: per-session surfaces')

      // 重连之后只可能读到新的改写；本地状态原样等下一次列表刷新。
      ctx.on('connection/reset', () => {
        for (const surface of surfaces.values()) void surface.reload()
      })

      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'message-edit',
        order: 12,
        locale: NS,
        inject: (sessionId) => {
          const surface = surfaceFor(sessionId)
          return {
            hooks: { edits: surface.items },
            openEditor: (messageId) => { surface.openEditor(messageId) },
          }
        },
      }, EditAction))

      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: 'message-edit-card',
        order: 20,
        locale: NS,
        inject: (sessionId) => {
          const surface = surfaceFor(sessionId)
          return {
            hooks: { edits: surface.items },
            openEditor: (messageId) => { surface.openEditor(messageId) },
          }
        },
      }, RewriteCard))

      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'message-edit-dialog',
        order: 3,
        locale: NS,
        inject: (sessionId) => {
          const surface = surfaceFor(sessionId)
          return {
            hooks: { edits: surface.items, editor: surface.editor },
            setDraft: (draft) => { surface.setDraft(draft) },
            save: (text) => surface.save(text),
            restore: () => surface.restore(),
            close: () => { surface.closeEditor() },
          }
        },
      }, EditDialog))
    }

    exports.apply = apply
    exports.inject = inject
    // 纯函数留一个后门给 node:test —— 浏览器里没人读它。
    exports.__internals = {
      assistantText,
      messageTextOfSnapshot,
      editedIdsInTurn,
      idsKeyOf,
      createStore,
      EditSurface,
      callApi,
      COPY,
      NS,
      API,
    }
    return module.exports
  },
})
