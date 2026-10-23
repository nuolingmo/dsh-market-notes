/**
 * Market Notes — client half.
 *
 * One row inside Settings → General: shows the last scan result and provides
 * the 「立即扫描」 button. The notes themselves appear on the market cards.
 */
window.__ModuleLoader__.load({
  id: 'dsh-market-notes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const STATUS_URL = '/dsh-market-notes/status'
    const SCAN_URL = '/dsh-market-notes/scan'

    const DICT = {
      title: '插件中文备注',
      description: '给 dshmarket 里还没有备注的插件自动写一句中文说明，约 60 字；已有备注不会动，扫描结果直接显示在市场卡片上。AI 写的备注可重新生成，你手写的不会动。',
      scan: '立即扫描',
      scanning: '扫描中…',
      regenerate: '重新生成 AI 备注',
      regenerating: '重新生成中…',
      regenerateHint: '只重写带 🤖 的备注',
      last: '上次扫描',
      generated: '生成 {n} 条',
      skipped: '已有 {n} 条跳过',
      failed: '失败 {n} 条',
      noSource: '无资料 {n} 条',
      never: '还没有扫描记录，插件启动 30 秒后会自动扫一次。',
      error: '出错了',
      unavailable: '连接不到备注服务',
    }

    const styles = `
      .dmn-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 2px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
      .dmn-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .dmn-title { font-size: 13.5px; font-weight: 600; line-height: 1.4; }
      .dmn-desc { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
      .dmn-status { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dmn-error { color: var(--dsw-alias-state-error-primary); }
      .dmn-side { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
      .dmn-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer; min-width: 84px; }
      .dmn-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
      .dmn-btn:disabled { opacity: .55; cursor: default; }
      .dmn-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
      .dmn-btn-primary:hover:not(:disabled) { filter: brightness(1.06); }
      .dmn-btn-secondary { min-width: 84px; font-size: 11.5px; padding: 4px 10px; }
      .dmn-hint { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
    `

    function apiBase() {
      if (typeof location !== 'undefined' && /^https?:$/u.test(location.protocol)) return location.origin
      return ''
    }

    async function readJson(response) {
      try {
        return await response.json()
      } catch {
        return {}
      }
    }

    function timeOf(iso) {
      if (typeof iso !== 'string') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function describeError(error) {
      if (error === undefined || error === null) return 'unknown'
      return error instanceof Error ? error.message : String(error)
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) return null
        return this.props.children
      }
    }

    function NotesRow() {
      const [state, setState] = useState({ loading: true, scanning: false, report: null, error: null })
      const [busyMode, setBusyMode] = useState(null) // null | 'scan' | 'ai'
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false }, [])

      const t = useCallback((key, params) => {
        const raw = DICT[key] ?? key
        if (params === undefined) return raw
        return raw.replace(/\{(\w+)\}/gu, (_match, name) => String(params[name] ?? ''))
      }, [])

      const loadStatus = useCallback(async () => {
        try {
          const response = await fetch(`${apiBase()}${STATUS_URL}`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await readJson(response)
          if (!mounted.current) return
          setState({ loading: false, scanning: data.scanning === true, report: data.report ?? null, error: null })
        } catch {
          if (!mounted.current) return
          setState({ loading: false, scanning: false, report: null, error: t('unavailable') })
        }
      }, [t])

      useEffect(() => {
        void loadStatus()
      }, [loadStatus])

      // While a scan is running (this row's button, the auto scan, or another
      // tab), re-read /status every 2 s so the row never stays stuck.
      useEffect(() => {
        if (!state.scanning) return undefined
        const timer = setInterval(() => { void loadStatus() }, 2000)
        return () => clearInterval(timer)
      }, [state.scanning, loadStatus])

      const scanNow = useCallback(async (forceAi) => {
        setBusyMode(forceAi ? 'ai' : 'scan')
        setState((previous) => ({ ...previous, scanning: true, error: null }))
        try {
          const response = await fetch(`${apiBase()}${SCAN_URL}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(forceAi ? { force: 'ai' } : {}),
          })
          const data = await readJson(response)
          if (!response.ok || data.ok !== true) throw new Error(data.error !== undefined ? String(data.error) : `HTTP ${response.status}`)
          if (!mounted.current) return
          setState({ loading: false, scanning: false, report: data.report ?? null, error: null })
        } catch (error) {
          if (!mounted.current) return
          setState((previous) => ({ ...previous, scanning: false, error: describeError(error) }))
        } finally {
          if (mounted.current) setBusyMode(null)
        }
      }, [])

      const busy = busyMode !== null
      const report = state.report
      let status
      if (state.loading) {
        status = null
      } else if (state.error !== null) {
        status = h('div', { className: 'dmn-status dmn-error' }, `${t('error')}：${state.error}`)
      } else if (report === null) {
        status = h('div', { className: 'dmn-status' }, t('never'))
      } else {
        const parts = []
        if (Array.isArray(report.generated) && report.generated.length > 0) parts.push(t('generated', { n: report.generated.length }))
        if (Array.isArray(report.skippedExisting) && report.skippedExisting.length > 0) parts.push(t('skipped', { n: report.skippedExisting.length }))
        if (Array.isArray(report.failed) && report.failed.length > 0) parts.push(t('failed', { n: report.failed.length }))
        if (Array.isArray(report.noSource) && report.noSource.length > 0) parts.push(t('noSource', { n: report.noSource.length }))
        const errorTail = typeof report.error === 'string' && report.error.length > 0 ? ` · ${report.error}` : ''
        status = h(
          'div',
          { className: report.error ? 'dmn-status dmn-error' : 'dmn-status' },
          `${t('last')} ${timeOf(report.at)}${parts.length > 0 ? '：' + parts.join(' · ') : ''}${errorTail}`,
        )
      }

      return h(
        'div',
        { className: 'dmn-row' },
        h('style', {}, styles),
        h(
          'div',
          { className: 'dmn-main' },
          h('div', { className: 'dmn-title' }, t('title')),
          h('div', { className: 'dmn-desc' }, t('description')),
          status,
        ),
        h(
          'div',
          { className: 'dmn-side' },
          h(
            'button',
            {
              type: 'button',
              className: 'dmn-btn dmn-btn-primary',
              disabled: busy,
              onClick: () => void scanNow(false),
            },
            busy ? t('scanning') : t('scan'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dmn-btn dmn-btn-secondary',
              disabled: busy,
              onClick: () => void scanNow(true),
            },
            busyMode === 'ai' ? t('regenerating') : t('regenerate'),
          ),
          h('div', { className: 'dmn-hint' }, t('regenerateHint')),
        ),
      )
    }

    return {
      name: 'market-notes',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'market-notes',
              order: 91,
            },
            () => h(Boundary, null, h(NotesRow)),
          ),
        )
      },
    }
  },
})
