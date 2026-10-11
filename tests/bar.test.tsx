import { expect, mock, test } from 'claude-code/testing'

const spawn = (id: string, subagentType: string, description: string) =>
  ({ tool_use_id: id, prompt: 'x', description, subagentType, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false }) as never

test('the bar follows a batch of helpers, and the panel lists them', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('agent.spawn', (_$, e) => ({ agentId: `ag-${e.tool_use_id}`, model: 'claude-opus-5-5' }))
  on('turn.complete', () => ({ text: 'ok' }))

  const props = { bodyColumns: 100, hasSurvey: false } as never
  // Nothing has run: the engine draws its own.
  let ui = await $.ui.mount({ plugin: 'ev-charging', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()

  await $.agent.spawn(spawn('1', 'general-purpose', 'Summarise the changelog'))
  await $.agent.spawn(spawn('2', 'Explore', 'Find the config files'))
  await $.agent.spawn(spawn('3', 'Plan', 'Plan the refactor'))
  await $.turn.complete({ agentId: 'ag-1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' })

  for (const surface of ['terminal', 'desktop'] as const) {
    ui = await $.ui.mount({ plugin: 'ev-charging', surface, component: 'AbovePrompt', props })
    const drawn = JSON.stringify(await ui.drawn())
    // The desktop bar is one Svg (the kit keeps its alt, not its paint); the terminal spells it out.
    expect(drawn).toContain('×3')
    await ui.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'ev-charging', surface: 'desktop', component: 'Pane', requestId: 'ev-charging-agents', props: { bodyColumns: 60 } as never } as never)
  expect(JSON.stringify(await pane.drawn())).toContain('Charging · 2')
  await pane.unmount()

  await $.turn.complete({ agentId: 'ag-2', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' })
  await $.turn.complete({ agentId: 'ag-3', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' })
  ui = await $.ui.mount({ plugin: 'ev-charging', surface: 'desktop', component: 'AbovePrompt', props })
  const finished = JSON.stringify(await ui.drawn())
  expect(finished).toContain('×3')
  await ui.press({ key: 'crew-dismiss' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})
