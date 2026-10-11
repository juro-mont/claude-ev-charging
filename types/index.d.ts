export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  steps: number
}

/** One burst of helper agents: from the first spawn while none ran, until dismissed. */
export type Batch = {
  startedAt: number
  isDismissed: boolean
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'ev-charging': {
      agents: AgentRun[]
      batch: Batch | null
      panel: Panel
      now: number
    }
  }
}
