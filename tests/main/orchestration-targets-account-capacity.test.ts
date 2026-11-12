import { describe, expect, it, vi } from 'vitest'
import {
  createOrchestrationExecutor,
  OrchestrationDispatches,
  type OrchestrationDeps
} from '../../src/main/chat/chat-engine-orchestration'
import type { AgentAccountUsage, HarnessAccount } from '../../src/lib/types'
import { LOCAL_OVEN_ID } from '../../src/lib/ovens'
import type { OrchestrationToolContext } from '../../src/main/utilities/utility-orchestration-service'

/**
 * `cio_orchestrate_targets` and the `agentAccountVisibility` switch.
 *
 * The target list is the only place an agent can learn which connected account
 * still has subscription capacity, so the switch has two obligations: report
 * capacity when it is on, and report none at all (without probing a single
 * account) when it is off. An absent field is the shipped default, which is on.
 */

const account: HarnessAccount = {
  id: 'account-codex-main',
  harnessId: 'codex',
  providerId: 'openai',
  providerName: 'OpenAI',
  label: 'Codex main',
  containerKind: 'managed',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1
}

const usage: AgentAccountUsage = {
  harnessId: 'codex',
  providerId: 'openai',
  accountId: account.id,
  rateLimits: [
    { id: 'five_hour', label: '5-hour', usedPercent: 42, resetsAt: 1_800_000_000_000 },
    // A window with neither a percentage nor a reset says nothing an agent can
    // act on, so it never reaches the list.
    { id: 'weekly', label: 'Weekly', status: 'allowed' }
  ],
  credits: { balance: 7, hasCredits: true }
}

/** One account's capacity as the tool reports it, read back for the assertions. */
interface TargetAccountCapacity {
  windows: Array<{ label: string; usedPercent?: number; resetsAt?: number }>
  creditsRemaining?: string
  needsSignIn?: boolean
}

interface TargetsResult {
  accountsQueryable: boolean
  accounts: Array<{ id: string; capacity?: TargetAccountCapacity }>
}

const context: OrchestrationToolContext = {
  projectId: 'project-1',
  threadId: 'thread-1',
  projectPath: '/tmp/project-1',
  sessionId: 'session-1',
  harnessId: 'codex'
}

/** The narrow surface `readTargets` reads, with the unrelated deps stubbed out. */
function targetsDeps(overrides: Partial<OrchestrationDeps>): OrchestrationDeps {
  return {
    listProviderCatalogs: async () => [],
    refreshProviderCatalogs: async () => [],
    listProjects: async () => [],
    listAccounts: async () => [account],
    listOvens: async () => ({
      ovens: [],
      defaultOvenId: LOCAL_OVEN_ID,
      secureStorageAvailable: true
    }),
    harnessInventory: async () => [],
    listModelProfiles: async () => [],
    getConfig: async () => ({}),
    accountUsage: async () => [],
    getThread: async () => null,
    getThreadById: async () => null,
    listDispatchedThreads: async () => [],
    updateThreadSettings: async () => undefined,
    clearStoppedByUser: async () => undefined,
    pendingRequestKind: () => null,
    latestAssistantText: async () => null,
    createThread: async () => {
      throw new Error('readTargets never creates a thread')
    },
    sendPrompt: async () => undefined,
    answerQuestion: async () => undefined,
    answerSecret: async () => undefined,
    replyPermission: async () => undefined,
    resolveThreadSecret: async () => null,
    recordDispatch: async () => undefined,
    ...overrides
  }
}

async function readTargets(deps: OrchestrationDeps): Promise<TargetsResult> {
  const executor = createOrchestrationExecutor(deps, new OrchestrationDispatches(), {
    current: null
  })
  return (await executor('targets', {}, context)) as TargetsResult
}

describe('cio_orchestrate_targets account capacity', () => {
  it('reports per-account capacity when the user allows it', async () => {
    const result = await readTargets(
      targetsDeps({
        getConfig: async () => ({ agentAccountVisibility: true }),
        accountUsage: async () => [usage]
      })
    )

    expect(result.accountsQueryable).toBe(true)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.capacity).toEqual({
      windows: [{ label: '5-hour', usedPercent: 42, resetsAt: 1_800_000_000_000 }],
      creditsRemaining: '7 credits left'
    })
  })

  it('treats an absent switch as on', async () => {
    const accountUsage = vi.fn(async () => [usage])
    const result = await readTargets(targetsDeps({ getConfig: async () => ({}), accountUsage }))

    expect(result.accountsQueryable).toBe(true)
    expect(accountUsage).toHaveBeenCalledTimes(1)
    expect(result.accounts[0]?.capacity?.windows).toHaveLength(1)
  })

  it('reports no capacity and probes nothing when the user turns it off', async () => {
    const accountUsage = vi.fn(async (): Promise<AgentAccountUsage[]> => [usage])
    const result = await readTargets(
      targetsDeps({
        getConfig: async () => ({ agentAccountVisibility: false }),
        accountUsage
      })
    )

    expect(result.accountsQueryable).toBe(false)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.capacity).toBeUndefined()
    expect(accountUsage).not.toHaveBeenCalled()
  })
})
