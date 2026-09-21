import type {
  AgentCapabilityCatalog,
  AgentCapabilitySource,
  BaseUrlProvider,
  BaseUrlProviderCopyClipboardRequest,
  BaseUrlProviderCreateRequest,
  BaseUrlProviderFetchModelsRequest,
  BaseUrlProviderUpdateRequest,
  ComputerUseActivity,
  ComputerUsePipState,
  CuaBridgeStatus,
  CuaUpdateCheck,
  DiscoveredBaseUrlModel,
  HarnessAccount,
  HarnessInstallHandoff,
  HarnessInstallInfo,
  HarnessManifestEntry,
  HarnessUninstallHandoff,
  HarnessUpdateHandoff,
  HarnessUpdateStatus,
  NativeMcpContent,
  NativeSkillContent,
  OfferedProvider,
  PendingHarnessAccount,
  ProviderAccountAuthStatus,
  ProviderAccountLoginHandoff,
  ProviderAccountLoginOptions,
  ProviderConnectionInfo,
  ResolvedUtility,
  SkillMarketDetail,
  SkillMarketInstallRequest,
  InstalledSkillLocation,
  SkillMarketLeaderboard,
  SkillMarketSearchResult,
  SkillMarketView,
  SkillUninstallReport,
  ThreadSettings,
  UtilityBundleInstallRequest,
  UtilityCatalog,
  UtilityCredentialInput,
  UtilityDefinition,
  UtilityDefinitionInput,
  UtilityDefinitionPatch,
  UtilityResolutionContext,
  UtilitySearchOptions,
  UtilitySetupReport,
  VisionModelRecord
} from '../types'
import type { WorkerNameSettings } from '../assignment/worker-names'
import type { CioPromptId, CioPromptSetting } from '../cio-prompts'
import type { Contract } from './contract-helpers'

export const invokeProviderContract = {
  'capabilities:readSkill': {} as Contract<
    [source: AgentCapabilitySource],
    NativeSkillContent | null
  >,
  'capabilities:updateSkill': {} as Contract<
    [source: AgentCapabilitySource, instructions: string],
    boolean
  >,
  'capabilities:deleteSkill': {} as Contract<[source: AgentCapabilitySource], boolean>,
  'capabilities:readMcp': {} as Contract<[source: AgentCapabilitySource], NativeMcpContent | null>,
  'capabilities:updateMcp': {} as Contract<
    [source: AgentCapabilitySource, content: NativeMcpContent],
    boolean
  >,
  'capabilities:deleteMcp': {} as Contract<[source: AgentCapabilitySource], boolean>,
  'capabilities:listAll': {} as Contract<[], AgentCapabilityCatalog>,
  'visionModels:list': {} as Contract<[], VisionModelRecord[]>,
  'cioPrompts:list': {} as Contract<[], CioPromptSetting[]>,
  'cioPrompts:save': {} as Contract<[id: CioPromptId, template: string], CioPromptSetting[]>,
  'cioPrompts:reset': {} as Contract<[id: CioPromptId], CioPromptSetting[]>,
  'workerNames:getSettings': {} as Contract<[], WorkerNameSettings>,
  'workerNames:saveCustom': {} as Contract<[names: string[]], void>,
  'providers:check': {} as Contract<[providerId: string], ProviderConnectionInfo>,
  'providers:checkAll': {} as Contract<[force?: boolean], ProviderConnectionInfo[]>,
  'providers:getStatus': {} as Contract<[], ProviderConnectionInfo[]>,
  'harnessUpdates:check': {} as Contract<[harnessId: string], HarnessUpdateStatus>,
  'harnessUpdates:checkAll': {} as Contract<[force?: boolean], HarnessUpdateStatus[]>,
  'harnessUpdates:handoff': {} as Contract<[harnessId: string], HarnessUpdateHandoff>,
  'harnessInstall:getInfo': {} as Contract<[harnessId: string], HarnessInstallInfo>,
  'harnessInstall:handoff': {} as Contract<[harnessId: string], HarnessInstallHandoff>,
  'harnessUninstall:handoff': {} as Contract<[harnessId: string], HarnessUninstallHandoff>,
  'harnessManifest:list': {} as Contract<[], HarnessManifestEntry[]>,
  'harnessManifest:confirm': {} as Contract<
    [input: { harnessId: string; behavior: string; value: boolean }],
    void
  >,
  'harnessManifest:reset': {} as Contract<[input: { harnessId: string; behavior: string }], void>,
  'harnessAutoUpdate:list': {} as Contract<[], Record<string, boolean>>,
  'harnessAutoUpdate:set': {} as Contract<[input: { harnessId: string; value: boolean }], void>,
  'providerAccounts:getAuthStatus': {} as Contract<
    [harnessId: string, projectPath?: string],
    ProviderAccountAuthStatus
  >,
  'providerAccounts:list': {} as Contract<
    [harnessId?: string, refresh?: boolean],
    HarnessAccount[]
  >,
  'providerAccounts:prepare': {} as Contract<
    [harnessId: string, providerId?: string],
    PendingHarnessAccount
  >,
  'providerAccounts:inspectPending': {} as Contract<
    [pendingAccountId: string],
    ProviderAccountAuthStatus
  >,
  'providerAccounts:finalizePending': {} as Contract<
    [pendingAccountId: string, providerId: string, label?: string],
    HarnessAccount
  >,
  'providerAccounts:cancelPending': {} as Contract<[pendingAccountId: string], void>,
  'providerAccounts:rename': {} as Contract<[accountId: string, label: string], HarnessAccount>,
  /** Mark an account as its harness's default for the account's provider.
   *  Returns the harness's full account list so callers can refresh caches. */
  'providerAccounts:setDefault': {} as Contract<[accountId: string], HarnessAccount[]>,
  'providerAccounts:remove': {} as Contract<[accountId: string], boolean>,
  'providerAccounts:beginLogin': {} as Contract<
    [harnessId: string, options?: ProviderAccountLoginOptions],
    ProviderAccountLoginHandoff
  >,
  'providerAccounts:listOffered': {} as Contract<[harnessId: string], OfferedProvider[]>,
  'providerAccounts:logout': {} as Contract<
    [harnessId: string, providerId?: string, accountId?: string],
    void
  >,
  'providerAccounts:setApiKey': {} as Contract<
    [harnessId: string, providerId: string, apiKey: string, accountId?: string],
    void
  >,
  'providerAccounts:beginOAuthLogin': {} as Contract<
    [harnessId: string, providerId: string, accountId?: string],
    string
  >,
  'providerAccounts:respondOAuthPrompt': {} as Contract<[loginId: string, value: string], void>,
  'providerAccounts:cancelOAuthLogin': {} as Contract<[loginId: string], void>,
  'providerAccounts:getHidden': {} as Contract<[harnessId: string], string[]>,
  'providerAccounts:setHidden': {} as Contract<
    [harnessId: string, providerId: string, hidden: boolean],
    string[]
  >,
  'baseUrlProviders:list': {} as Contract<[], BaseUrlProvider[]>,
  'baseUrlProviders:create': {} as Contract<[input: BaseUrlProviderCreateRequest], BaseUrlProvider>,
  'baseUrlProviders:update': {} as Contract<
    [harnessId: string, id: string, patch: BaseUrlProviderUpdateRequest],
    BaseUrlProvider
  >,
  'baseUrlProviders:delete': {} as Contract<[harnessId: string, id: string], boolean>,
  'baseUrlProviders:copyProviderToClipboard': {} as Contract<
    [input: BaseUrlProviderCopyClipboardRequest],
    void
  >,
  'baseUrlProviders:fetchModels': {} as Contract<
    [input: BaseUrlProviderFetchModelsRequest],
    DiscoveredBaseUrlModel[]
  >,
  'baseUrlProviders:fetchUsage': {} as Contract<
    [harnessId: string, id: string],
    import('../types').CustomProviderUsage | null
  >,
  'gateway:list': {} as Contract<[], import('../gateway-types').GatewayStatus[]>,
  'gateway:setEnabled': {} as Contract<
    [pluginId: string, enabled: boolean],
    import('../gateway-types').GatewayStatus
  >,
  'gateway:start': {} as Contract<[pluginId: string], import('../gateway-types').GatewayStatus>,
  'gateway:stop': {} as Contract<[pluginId: string], import('../gateway-types').GatewayStatus>,
  'gateway:uninstall': {} as Contract<[pluginId: string], import('../gateway-types').GatewayStatus>,
  'gateway:update': {} as Contract<[pluginId: string], import('../gateway-types').GatewayStatus>,
  'gateway:copyDashboardPassword': {} as Contract<[pluginId: string], void>,
  'gateway:refreshCatalog': {} as Contract<
    [pluginId: string],
    import('../gateway-types').GatewayModelInfo[]
  >,
  'utilities:list': {} as Contract<[options?: UtilitySearchOptions], UtilityCatalog>,
  'utilities:get': {} as Contract<[id: string], UtilityDefinition | null>,
  'utilities:create': {} as Contract<[input: UtilityDefinitionInput], UtilityDefinition>,
  'utilities:installBundle': {} as Contract<
    [request: UtilityBundleInstallRequest],
    UtilityDefinition[]
  >,
  'utilities:setupWithAgent': {} as Contract<
    [projectId: string, taskId: string, settings: ThreadSettings, request: string],
    UtilitySetupReport
  >,
  'utilities:searchSkillMarket': {} as Contract<[query: string], SkillMarketSearchResult>,
  'utilities:listSkillMarket': {} as Contract<[view: SkillMarketView], SkillMarketLeaderboard>,
  'utilities:getSkillMarketDetail': {} as Contract<[id: string], SkillMarketDetail>,
  'utilities:installMarketSkill': {} as Contract<[request: SkillMarketInstallRequest], string>,
  'utilities:installedSkillLocations': {} as Contract<[], InstalledSkillLocation[]>,
  'utilities:uninstallMarketSkill': {} as Contract<[skillId: string], SkillUninstallReport>,
  'utilities:update': {} as Contract<
    [id: string, patch: UtilityDefinitionPatch],
    UtilityDefinition
  >,
  'utilities:delete': {} as Contract<[id: string], boolean>,
  'utilities:setCredential': {} as Contract<
    [utilityId: string, input: UtilityCredentialInput],
    UtilityDefinition
  >,
  'utilities:removeCredential': {} as Contract<
    [utilityId: string, credentialId: string],
    UtilityDefinition
  >,
  'utilities:resolve': {} as Contract<[context: UtilityResolutionContext], ResolvedUtility[]>,
  'computerUse:getCuaStatus': {} as Contract<[], CuaBridgeStatus>,
  'computerUse:setCuaEnabled': {} as Contract<[enabled: boolean], CuaBridgeStatus>,
  /**
   * Asks the installed driver whether Cua published a newer release. Null when
   * no driver is installed. `skipCache` forces a fresh GitHub round trip instead
   * of the driver's 20-hour on-disk cache.
   */
  'computerUse:checkCuaUpdate': {} as Contract<[skipCache?: boolean], CuaUpdateCheck | null>,
  /**
   * Updates the installed driver in place through Cua's own updater and answers
   * with the refreshed bridge status. Long-running: the settings surface follows
   * `computerUse:cuaUpdate` while it runs.
   */
  'computerUse:updateCua': {} as Contract<[], CuaBridgeStatus>,
  'computerUse:pipGetState': {} as Contract<[], ComputerUsePipState>,
  /** Every thread whose agent is currently driving the computer, so a renderer
   *  that reloads mid-run re-seeds its row indicators. */
  'computerUse:activityGet': {} as Contract<[], ComputerUseActivity[]>,
  /** Device pixels of preview the overlay is about to paint, so the captured
   *  frame is never upscaled. Sent whenever the preview footprint changes. */
  'computerUse:pipSetFrameWidth': {} as Contract<[deviceWidth: number], void>,
  'computerUse:pipBringToFront': {} as Contract<[], void>,
  'computerUse:pipDismiss': {} as Contract<[], void>
}
