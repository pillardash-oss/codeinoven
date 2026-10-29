import type { ChatEngine } from '../chat-engine'
import { ChatEngineProvidersAccounts } from './chat-engine-providers-accounts'
import { ChatEngineTurns } from './chat-engine-turns'
import { ChatEngineTurnsDispatch } from './chat-engine-turns-dispatch'
import { ChatEngineMisc } from './chat-engine-misc'
import { ChatEngineUtilities } from './chat-engine-utilities'
import { ChatEngineUtilitiesMcp } from './chat-engine-utilities-mcp'
import { ChatEngineMediaVisual } from './chat-engine-media-visual'
import { ChatEngineUtilitiesTools } from './chat-engine-utilities-tools'
import { ChatEngineAssignmentWorkers } from './chat-engine-assignment-workers'
import { ChatEngineThreadsTitle } from './chat-engine-threads-title'
import { ChatEngineLifecycleBoot } from './chat-engine-lifecycle-boot'
import { ChatEngineQuestionsAsk } from './chat-engine-questions-ask'
import { ChatEngineSecrets } from './chat-engine-secrets'
import { ChatEngineQuestions } from './chat-engine-questions'
import { ChatEngineSpeech } from './chat-engine-speech'
import { ChatEngineRuntimeWorkflows } from './chat-engine-runtime-workflows'
import { ChatEngineLifecycleShutdown } from './chat-engine-lifecycle-shutdown'
import { ChatEngineProcesses } from './chat-engine-processes'
import { ChatEngineTurnsSessions } from './chat-engine-turns-sessions'
import { ChatEngineThreadLifecycle } from './chat-engine-thread-lifecycle'
import { ChatEngineMediaArtifacts } from './chat-engine-media-artifacts'
import { ChatEngineAudit } from './chat-engine-audit'
import { ChatEngineProvidersCatalog } from './chat-engine-providers-catalog'
import { ChatEngineProvidersHarness } from './chat-engine-providers-harness'
import { ChatEngineMessagesLoad } from './chat-engine-messages-load'
import { ChatEngineTranscripts } from './chat-engine-transcripts'
import { ChatEngineMessagesWrite } from './chat-engine-messages-write'
import { ChatEngineAssignment } from './chat-engine-assignment'
import { ChatEngineAssistantAuthoring } from './chat-engine-assistant-authoring'
import { ChatEngineThreadsDelete } from './chat-engine-threads-delete'
import { ChatEngineTemporaryChats } from './chat-engine-temporary-chats'
import { ChatEngineTurnsSteer } from './chat-engine-turns-steer'
import { ChatEngineAssignmentRun } from './chat-engine-assignment-run'
import { ChatEngineTurnsSendPrompt } from './chat-engine-turns-send-prompt'
import { ChatEngineBrainstorm } from './chat-engine-brainstorm'
import { ChatEngineUtilitiesGateway } from './chat-engine-utilities-gateway'
import { ChatEngineRuntimeAgents } from './chat-engine-runtime-agents'
import { ChatEngineRankingsGrade } from './chat-engine-rankings-grade'
import { ChatEngineRuntimeConnectivity } from './chat-engine-runtime-connectivity'
import { ChatEnginePermissions } from './chat-engine-permissions'
import { ChatEngineBrainstormReview } from './chat-engine-brainstorm-review'
import { ChatEnginePrd } from './chat-engine-prd'
import { ChatEngineBrainstormGenerate } from './chat-engine-brainstorm-generate'
import { ChatEngineSpecAuthoring } from './chat-engine-spec-authoring'
import { ChatEngineAuditRun } from './chat-engine-audit-run'
import { ChatEngineAuditReport } from './chat-engine-audit-report'
import { ChatEngineSpec } from './chat-engine-spec'
import { ChatEngineMemory } from './chat-engine-memory'
import { ChatEngineSpecLifecycle } from './chat-engine-spec-lifecycle'
import { ChatEngineMessages } from './chat-engine-messages'
import { ChatEngineQuestionsSecrets } from './chat-engine-questions-secrets'
import { ChatEngineTurnsStream } from './chat-engine-turns-stream'
import { ChatEngineLifecycle } from './chat-engine-lifecycle'
import { ChatEngineThreadsCreate } from './chat-engine-threads-create'
import { ChatEngineTurnsSessionIdle } from './chat-engine-turns-session-idle'
import { ChatEngineRankings } from './chat-engine-rankings'
import { ChatEngineRankingsQueue } from './chat-engine-rankings-queue'

/** The concern units a ChatEngine delegates to, built once in its constructor. */
export function buildChatEngineUnits(engine: ChatEngine) {
  return {
    'providers-accounts': new ChatEngineProvidersAccounts(engine),
    turns: new ChatEngineTurns(engine),
    'turns-dispatch': new ChatEngineTurnsDispatch(engine),
    misc: new ChatEngineMisc(engine),
    utilities: new ChatEngineUtilities(engine),
    'utilities-mcp': new ChatEngineUtilitiesMcp(engine),
    'media-visual': new ChatEngineMediaVisual(engine),
    'utilities-tools': new ChatEngineUtilitiesTools(engine),
    'assignment-workers': new ChatEngineAssignmentWorkers(engine),
    'threads-title': new ChatEngineThreadsTitle(engine),
    'lifecycle-boot': new ChatEngineLifecycleBoot(engine),
    'questions-ask': new ChatEngineQuestionsAsk(engine),
    secrets: new ChatEngineSecrets(engine),
    questions: new ChatEngineQuestions(engine),
    speech: new ChatEngineSpeech(engine),
    'runtime-workflows': new ChatEngineRuntimeWorkflows(engine),
    'lifecycle-shutdown': new ChatEngineLifecycleShutdown(engine),
    processes: new ChatEngineProcesses(engine),
    'turns-sessions': new ChatEngineTurnsSessions(engine),
    'thread-lifecycle': new ChatEngineThreadLifecycle(engine),
    'media-artifacts': new ChatEngineMediaArtifacts(engine),
    audit: new ChatEngineAudit(engine),
    'providers-catalog': new ChatEngineProvidersCatalog(engine),
    'providers-harness': new ChatEngineProvidersHarness(engine),
    'messages-load': new ChatEngineMessagesLoad(engine),
    transcripts: new ChatEngineTranscripts(engine),
    'messages-write': new ChatEngineMessagesWrite(engine),
    assignment: new ChatEngineAssignment(engine),
    'assistant-authoring': new ChatEngineAssistantAuthoring(engine),
    'threads-delete': new ChatEngineThreadsDelete(engine),
    'temporary-chats': new ChatEngineTemporaryChats(engine),
    'turns-steer': new ChatEngineTurnsSteer(engine),
    'assignment-run': new ChatEngineAssignmentRun(engine),
    'turns-send-prompt': new ChatEngineTurnsSendPrompt(engine),
    brainstorm: new ChatEngineBrainstorm(engine),
    'utilities-gateway': new ChatEngineUtilitiesGateway(engine),
    'runtime-agents': new ChatEngineRuntimeAgents(engine),
    'rankings-grade': new ChatEngineRankingsGrade(engine),
    'runtime-connectivity': new ChatEngineRuntimeConnectivity(engine),
    permissions: new ChatEnginePermissions(engine),
    'brainstorm-review': new ChatEngineBrainstormReview(engine),
    prd: new ChatEnginePrd(engine),
    'brainstorm-generate': new ChatEngineBrainstormGenerate(engine),
    'spec-authoring': new ChatEngineSpecAuthoring(engine),
    'audit-run': new ChatEngineAuditRun(engine),
    'audit-report': new ChatEngineAuditReport(engine),
    spec: new ChatEngineSpec(engine),
    memory: new ChatEngineMemory(engine),
    'spec-lifecycle': new ChatEngineSpecLifecycle(engine),
    messages: new ChatEngineMessages(engine),
    'questions-secrets': new ChatEngineQuestionsSecrets(engine),
    'turns-stream': new ChatEngineTurnsStream(engine),
    lifecycle: new ChatEngineLifecycle(engine),
    'threads-create': new ChatEngineThreadsCreate(engine),
    'turns-session-idle': new ChatEngineTurnsSessionIdle(engine),
    rankings: new ChatEngineRankings(engine),
    'rankings-queue': new ChatEngineRankingsQueue(engine)
  } as const
}

export type ChatEngineUnits = ReturnType<typeof buildChatEngineUnits>
