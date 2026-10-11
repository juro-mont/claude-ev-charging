// ev-charging: an EV-charging progress bar above the prompt while Claude runs helper
// agents, and an agents panel (/agents-info). Adapted from savvy-progress by
// johnnyvizz (github.com/johnnyvizz/claude-kit, MIT): the crabs became Type 2 plugs,
// and the bar follows any subagents instead of a flow.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Batch, Panel } from '../types'

const agents = atom({ plugin: 'ev-charging', key: 'agents' } as const, [])
const batch = atom({ plugin: 'ev-charging', key: 'batch' } as const, null)
const panel = atom({ plugin: 'ev-charging', key: 'panel' } as const, { isCompact: false, isDoneCollapsed: false })
const now = atom({ plugin: 'ev-charging', key: 'now' } as const, 0)

const PANE = 'ev-charging-agents'

// Palette: an electric blue for current, green for a full charge, red for a fault.
const BLUE = '#302ee0'
const GLOW = '#4c66ff'
const LIGHT_BLUE = '#337dff'
const PURPLE = '#b04ac8'
const GREEN = '#16aa6a'
const RED = '#dd3633'
const GREY = '#8e94ad'

// What each kind of helper looks like.
const KIND: Record<string, { color: string; label: string }> = {
  'general-purpose': { color: BLUE, label: 'Helper' },
  Explore: { color: LIGHT_BLUE, label: 'Explorer' },
  Plan: { color: PURPLE, label: 'Planner' },
}

const kindOf = (type: string) => KIND[type.replace(/^[^:]*:/, '')] ?? { color: GREY, label: type || 'Agent' }

// ---------------------------------------------------------------------------
// Numbers.

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

const totals = (list: AgentRun[], at: number) => {
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { tokens, time: list.length ? end - start : 0 }
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const inBatch = (list: AgentRun[], b: Batch | null): AgentRun[] => (b ? list.filter(a => a.startedAt >= b.startedAt) : [])

// ---------------------------------------------------------------------------
// Drawing helpers.

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const charEm = (ch: string): number => (/[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56)

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// Ink and surface tokens, with their dark-mode twins.
const BASE_CSS = `<style>
.t{fill:#19192e}.s{fill:#6e7691}.m{fill:#c0c5d9}.k{fill:#eef0f7}.ln{stroke:#e6e9f2}.tile{fill:#f8f8fd;stroke:#e6e9f2}.face{fill:#ffffff}
@media (prefers-color-scheme: dark){.t{fill:#ededf5}.s{fill:#a3a8c3}.m{fill:#4a4e66}.k{fill:#23233a}.ln{stroke:#2e2e46}.tile{fill:#1c1c2e;stroke:#2e2e46}.face{fill:#14141f}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.35}}
.pin{animation:pin 1.4s ease-in-out infinite}
@keyframes pin{0%,100%{opacity:.25}35%{opacity:1}}
@media (prefers-reduced-motion: reduce){.live,.pin,.flow{animation:none!important}}
</style>`

// --- The Type 2 plug: the connector face every European EV driver knows, flat top,
// two signal pins over five power pins. Charging, its pins light up in turn;
// charged, they all glow green; stopped, they go dark.
const PINS: [number, number, number][] = [
  [-3.2, -5.4, 1.4],
  [3.2, -5.4, 1.4],
  [-5.8, 0, 2.1],
  [0, 0, 2.1],
  [5.8, 0, 2.1],
  [-3.2, 5.4, 2.1],
  [3.2, 5.4, 2.1],
]

// The order the pins light: signal first, then the power pins around the ring.
const PIN_ORDER = [0, 1, 4, 6, 5, 2, 3]

const plug = (x: number, y: number, color: string, status: 'running' | 'done' | 'failed' | 'idle', size = 24): string => {
  const k = size / 24
  const ring = status === 'failed' ? GREY : color
  const pinColor = status === 'done' ? GREEN : status === 'failed' ? GREY : color
  const pins = PINS.map(([px, py, r], i) => {
    const anim = status === 'running' ? ` class="pin" style="animation-delay:${(PIN_ORDER.indexOf(i) * 0.2).toFixed(1)}s"` : ''
    const op = status === 'failed' ? ' opacity=".5"' : ''
    return `<circle cx="${px}" cy="${py}" r="${r}" fill="${pinColor}"${anim}${op}/>`
  }).join('')
  // Flat-topped face: an arc under a straight top edge.
  const face = `<path class="face" d="M-7.8 -8.2 A11 11 0 1 0 7.8 -8.2 Z" stroke="${ring}" stroke-width="1.8" stroke-linejoin="round"/>`
  // Charging: a lightning badge on the plug's shoulder, pulsing.
  const bolt =
    status === 'running'
      ? `<g class="live" transform="translate(8.5,7.5)"><circle r="5.2" class="face" stroke="${color}" stroke-width="1.2"/><path d="M0.9 -3.4 L-2.1 0.6 H-0.1 L-0.9 3.4 L2.1 -0.6 H0.1 Z" fill="${color}"/></g>`
      : ''
  return `<g transform="translate(${x + 12 * k},${y + 12.5 * k}) scale(${k})">${face}${pins}${bolt}</g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="${GREEN}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="${RED}" stroke-width="1.8" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${BASE_CSS}${body}</svg>`

// ---------------------------------------------------------------------------
// The bar above the prompt: one SVG, since the desktop wraps sibling elements.
// A charging cable: current flows along the charged part, one segment per helper.

const H = 28
const BAR_H = 12

const batchLabel = (done: number, total: number, running: number): string =>
  running === 0 ? 'Fully charged' : `${done} of ${total} charged`

const rowSvg = (title: string, done: number, total: number, running: number, W: number): string => {
  const ratio = total ? done / total : 0
  const isFinished = running === 0
  const color = isFinished ? GREEN : BLUE
  const t = fitText(title, 13, Math.max(60, W * 0.3))
  const status = batchLabel(done, total, running)
  const statusW = Math.round(textWidth(status, 12)) + 8
  const BAR_X = Math.round(34 + textWidth(t, 13) + 14)
  const BAR_W = Math.max(60, W - BAR_X - statusW - 12)
  const y0 = (H - BAR_H) / 2
  // Even an empty batch shows a sliver of charge, so the flow has somewhere to run.
  const fillW = Math.max(BAR_H, Math.round(BAR_W * ratio))
  const runW = total ? Math.round((BAR_W * Math.min(total, done + running)) / total) : 0
  const id = `${isFinished ? 'f' : 'r'}${done}-${total}`
  const gaps: string[] = []
  for (let i = 1; i < total; i++) {
    const x = Math.round((BAR_W * i) / total)
    gaps.push(`<rect x="${x - 1}" y="0" width="2" height="${BAR_H}" class="face"/>`)
  }
  // The current: a bright pulse sliding along the charged part, then again.
  const pulseW = 48
  const flow = isFinished
    ? ''
    : `<style>.flow${id}{animation:flow${id} 1.4s linear infinite}@keyframes flow${id}{from{transform:translateX(${-pulseW}px)}to{transform:translateX(${runW}px)}}</style>
<rect class="flow flow${id}" width="${pulseW}" height="${BAR_H}" fill="url(#pulse${id})"/>`
  return svg(
    W,
    H,
    `<defs><clipPath id="c${id}"><rect width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>
<linearGradient id="g${id}" x1="0" x2="1"><stop offset="0" stop-color="${isFinished ? GREEN : BLUE}"/><stop offset="1" stop-color="${isFinished ? '#2bc985' : GLOW}"/></linearGradient>
<linearGradient id="pulse${id}" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
${plug(0, 1, color, isFinished ? 'done' : 'running', 26)}
<text class="t" x="34" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="600">${xml(t)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c${id})">
<rect class="live" width="${runW}" height="${BAR_H}" fill="${color}" opacity=".18"/>
<rect width="${fillW}" height="${BAR_H}" fill="url(#g${id})"/>
${flow}
${gaps.join('')}
</g>
</g>
<text class="s" x="${W - 2}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12" font-weight="500" font-variant-numeric="tabular-nums">${xml(status)}</text>`,
  )
}

// ---------------------------------------------------------------------------
// The agents panel, read like a charging session: duration and energy.

const headerSvg = (W: number, t: ReturnType<typeof totals>): string => {
  const gap = 6
  const tw = (W - gap) / 2
  const tile = (i: number, k: string, v: string, unit: string) =>
    `<rect class="tile" x="${i * (tw + gap) + 0.5}" y="0.5" width="${tw - 1}" height="47" rx="10"/>
<text class="s" x="${i * (tw + gap) + 11}" y="18" font-family="${FONT}" font-size="10.5" font-weight="600" letter-spacing=".06em">${k}</text>
<text class="t" x="${i * (tw + gap) + 11}" y="38" font-family="${FONT}" font-size="16" font-weight="600" font-variant-numeric="tabular-nums">${v}<tspan class="s" font-size="11" font-weight="500"> ${unit}</tspan></text>`
  return svg(W, 50, `${tile(0, 'SESSION', fmtTime(t.time), '')}${tile(1, 'ENERGY', fmtTokens(t.tokens), 'tokens')}`)
}

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const kind = kindOf(a.type)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.status === 'failed') meta.push('stopped')
  const stats = `${fmtTokens(a.tokens)} · ${fmtTime(elapsed(a, at))}`
  // The model line gives way to the numbers, so the two never run into each other.
  const metaW = Math.max(40, textW - textWidth(stats, 11) - 14)
  const fillW = Math.round(textW * (a.status === 'done' ? 1 : ctx / 100))
  const barColor = a.status === 'done' ? GREEN : a.status === 'failed' ? RED : kind.color
  return svg(
    W,
    62,
    `${plug(2, 8, kind.color, a.status, 28)}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW - 10))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${kind.color}" font-weight="600">${xml(kind.label)}</tspan><tspan class="s">  ${xml(fitText(meta.join(' · '), 11, metaW - textWidth(kind.label, 11) - 8))}</tspan></text>
<text class="s" x="${42 + textW}" y="34" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="42" y="44" width="${textW}" height="5" rx="2.5"/><rect x="42" y="44" width="${fillW}" height="5" rx="2.5" fill="${barColor}"/>
${statusMark(W - 8, 14, a.status, kind.color)}
<line class="ln" x1="0" y1="61.5" x2="${W}" y2="61.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], t: ReturnType<typeof totals>): string => {
  const ordered = [...list.filter(a => a.status === 'running'), ...list.filter(a => a.status !== 'running')]
  const fit = Math.max(1, Math.floor((W - 170) / 30))
  const shown = ordered.slice(0, fit)
  const more = ordered.length - shown.length
  const body = shown.map((a, i) => plug(i * 30, 3, kindOf(a.type).color, a.status, 24)).join('')
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${shown.length * 30 + 4}" y="20" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="20" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${fmtTime(t.time)} · ${fmtTokens(t.tokens)} tokens</text>`,
  )
}

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗' }

async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: 'Agents' })
  return true
}

async function track($: EngineInterface, e: { tool_use_id: string; subagentType: string; description: string }, started: { agentId?: string; model: string }): Promise<void> {
  const at = await $.clock.now()
  const list = await read($, agents)
  // The first helper while none is running starts a new batch for the bar.
  if (!list.some(a => a.status === 'running')) await update($, batch, () => ({ startedAt: at, isDismissed: false }))
  await update($, agents, prev => {
    const run: AgentRun = {
      id: started.agentId ?? e.tool_use_id,
      agentId: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      contextMax: windowOf(started.model),
      tokens: 0,
      steps: 0,
    }
    return [...prev.filter(a => a.id !== run.id), run].slice(-200)
  })
  await update($, now, () => at)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of helper agents: running and finished, with model, tokens and time',
    })
    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Agents panel opened.' : 'Agents panel closed.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    try {
      await track($, e, started)
    } catch {}
    return started
  })

  // Each model request of a subagent: live context and tokens.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    const sum =
      (usage.input_tokens || 0) +
      (usage.output_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0)
    await update($, agents, list =>
      list.map(a =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens: sum,
              contextMax: windowOf(model),
              tokens: a.tokens + sum,
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map(a => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  // A new message from the person clears a finished bar.
  on('prompt.submit', async ($, e, next) => {
    // Bookkeeping only: a failure here must never hold up the person's message.
    try {
      const list = await read($, agents)
      if (!list.some(a => a.status === 'running')) await update($, batch, b => (b ? { ...b, isDismissed: true } : b))
    } catch {}
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)
    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const t = totals(list, at)

    const toggleCompact = (
      <Button key="compact" label={p.isCompact ? 'Expand' : 'Collapse'} plain onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))} />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} Charged · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const summary = `${fmtTokens(t.tokens)} tokens, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, list, t)} alt={`${list.length} agents, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, t)} alt={summary} width={W} height={44} />
          {toggleCompact}
          {list.length === 0 && <Text dimColor>No helper agents yet.</Text>}
          {running.length > 0 && <Text dimColor>{`Charging · ${running.length}`}</Text>}
          {running.map(a => (
            <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, running`} width={W} height={66} />
          ))}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed &&
            finished.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${a.status}`} width={W} height={66} />
            ))}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const kind = kindOf(a.type)
      const ctx = ctxOf(a)
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={kind.color}>▣</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? RED : a.status === 'done' ? GREEN : kind.color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {kind.label} · {a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            <Text color={kind.color}>{ctxBar(a.status === 'done' ? 100 : ctx, barW)}</Text>
            <Text dimColor>
              {' '}
              {fmtTokens(a.tokens)} tokens · {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{summary}</Text>
          {toggleCompact}
        </Box>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={kindOf(a.type).color}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {list.length === 0 && <Text dimColor>No helper agents yet.</Text>}
            {running.length > 0 && <Text dimColor>Charging · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, batch)
    if (b === null || b.isDismissed || e.props.hasSurvey) return next(e)
    const list = inBatch(await read($, agents), b)
    if (list.length === 0) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const total = list.length
    const done = list.filter(a => a.status !== 'running').length
    const running = total - done
    const title = running ? (total === 1 ? '1 helper charging' : `${total} helpers charging`) : total === 1 ? 'Helper done' : `${total} helpers done`
    const crewButton = <Button key="crew-agents" label={`×${total}`} plain onPress={() => void togglePane($)} />
    const dismiss = <Button key="crew-dismiss" label="✕" plain role="dismiss" onPress={() => update($, batch, prev => (prev ? { ...prev, isDismissed: true } : prev))} />

    if ('Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={rowSvg(title, done, total, running, width)} alt={`${title}: ${batchLabel(done, total, running)}`} width={width} height={H} />
          {crewButton}
          {dismiss}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const width = Math.max(6, Math.min(40, cols - 50))
    const filled = Math.round((width * done) / total)
    return (
      <Box flexDirection="row" gap={2}>
        <Text color={running ? BLUE : GREEN}>● {title}</Text>
        <Text color={running ? BLUE : GREEN}>{'█'.repeat(filled) + '░'.repeat(width - filled)}</Text>
        <Text bold>{batchLabel(done, total, running)}</Text>
        {crewButton}
        {dismiss}
      </Box>
    )
  })
}
