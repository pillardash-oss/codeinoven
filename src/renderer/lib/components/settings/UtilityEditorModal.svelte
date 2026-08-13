<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Boxes,
    ChevronLeft,
    Globe2,
    Loader2,
    Server,
    Trash2,
    Upload,
    BookOpen
  } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { providerStore } from '$lib/stores/providers.svelte'
  import type { ScopeProject } from '$lib/stores/scope.svelte'
  import ProjectSelect from '../shared/ProjectSelect.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import ThreadSelect from '../shared/ThreadSelect.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import type {
    AgentCapabilityEntry,
    HarnessUtilityBinding,
    NativeMcpContent,
    Project,
    Thread,
    UtilityActivation,
    UtilityConfigMap,
    UtilityCredentialInput,
    UtilityBundleInstallRequest,
    UtilityDefinition,
    UtilityDefinitionInput,
    UtilityDefinitionPatch,
    UtilityKind,
    UtilityScope,
    WebToolProviderId
  } from '$shared/types'
  import { isOrchestrationChildThread } from '$shared/types'

  type ScopeLevel = UtilityScope['level']
  type BindingStrategy = HarnessUtilityBinding['strategy']

  /** What the shared editor is editing. */
  export type UtilityEditorTarget =
    | { kind: 'registry'; utility: UtilityDefinition | null }
    | { kind: 'native'; entry: AgentCapabilityEntry }

  interface BindingDraft {
    harnessId: string
    strategy: BindingStrategy
    nativeCapability: string
    transportName: string
  }

  interface UtilityDraft {
    id: string | null
    kind: UtilityKind
    name: string
    description: string
    enabled: boolean
    activation: UtilityActivation
    scopeLevel: ScopeLevel
    projectId: string
    threadId: string
    transport: 'stdio' | 'http' | 'sse'
    command: string
    args: string
    url: string
    environment: string
    instructions: string
    supportingFiles: string
    endpoint: string
    headers: string
    provider: WebToolProviderId
    backend: string
    providerId: string
    defaultModel: string
    descriptorHarnessId: string
    descriptorProviderId: string
    descriptorModelId: string
    bindings: BindingDraft[]
  }

  interface Props {
    open: boolean
    target: UtilityEditorTarget | null
    onClose: () => void
    /** Fired after a registry create/update completes. */
    onSaved?: (utility: UtilityDefinition) => void
    /** Fired after any successful mutation so the caller can reload. */
    onChanged?: () => void
  }

  let { open, target, onClose, onSaved, onChanged }: Props = $props()

  interface SetupPreset {
    id: string
    title: string
    description: string
    group: 'Ready to use' | 'Build your own'
    badge: string
  }

  const registryPresets: SetupPreset[] = [
    {
      id: 'svelte-mcp',
      title: 'Svelte MCP',
      description:
        'Official remote Svelte and SvelteKit documentation server. No command required.',
      group: 'Ready to use',
      badge: 'MCP'
    },
    {
      id: 'convex-mcp',
      title: 'Convex MCP',
      description:
        'Run the official Convex MCP server through Bun for project-aware database tools.',
      group: 'Ready to use',
      badge: 'MCP'
    },
    {
      id: 'convex-skill',
      title: 'Convex skill',
      description: 'Add focused Convex implementation guidance that agents load only when needed.',
      group: 'Ready to use',
      badge: 'Skill'
    },
    {
      id: 'exa-search',
      title: 'Exa search',
      description: 'Search the web with Exa. You only need to provide an API key.',
      group: 'Ready to use',
      badge: 'Web search'
    },
    {
      id: 'exa-fetch',
      title: 'Exa contents',
      description: 'Retrieve page contents through Exa for agents without native web fetch.',
      group: 'Ready to use',
      badge: 'Web fetch'
    },
    {
      id: 'firecrawl-skill',
      title: 'Firecrawl',
      description:
        'Add Firecrawl web context skills for agents: search, scrape, interact, parse, research, and monitoring. The CLI installs during the session.',
      group: 'Ready to use',
      badge: 'Skill'
    },
    {
      id: 'brave-search',
      title: 'Brave search',
      description: 'Search the web with the Brave Search API. You only need to provide an API key.',
      group: 'Ready to use',
      badge: 'Web search'
    },
    {
      id: 'custom-mcp',
      title: 'Custom MCP server',
      description: 'Paste a common MCP JSON configuration or enter a local command or remote URL.',
      group: 'Build your own',
      badge: 'MCP'
    },
    {
      id: 'custom-skill',
      title: 'Custom skill',
      description: 'Paste SKILL.md instructions and decide which harnesses may load them.',
      group: 'Build your own',
      badge: 'Skill'
    },
    {
      id: 'custom-web',
      title: 'Custom web utility',
      description: 'Connect a search or fetch API while keeping its key in secure storage.',
      group: 'Build your own',
      badge: 'Web'
    },
    {
      id: 'image-descriptor',
      title: 'Image descriptor',
      description:
        'Let text-only models describe attached images using a vision-capable model from the catalog.',
      group: 'Build your own',
      badge: 'Vision'
    },
    {
      id: 'plugin-bundle',
      title: 'Import plugin bundle',
      description:
        'Install a JSON manifest containing several MCP, skill, or web capabilities atomically.',
      group: 'Build your own',
      badge: 'Plugin'
    }
  ]

  const skillPlaceholder = `---
name: my-skill
description: What this skill helps with
---

# Instructions

Write the skill…`

  let saving = $state(false)
  let editorError = $state('')
  let setupPreset = $state<null | string>(null)
  let pluginManifest = $state('')
  let deleteTarget = $state<UtilityEditorTarget | null>(null)
  let draft = $state<UtilityDraft>(emptyDraft())
  let credentialId = $state('')
  let credentialLabel = $state('')
  let credentialValue = $state('')
  let credentialRequired = $state(false)
  let credentialEnvironmentVariable = $state('')
  let projects = $state<Project[]>([])
  let threads = $state<Thread[]>([])
  let projectIconUrls = $state<Record<string, string>>({})
  let secureStorageAvailable = $state(true)
  let loadingNative = $state(false)
  let utilities = $state<UtilityDefinition[]>([])

  let isNative = $derived(target?.kind === 'native')
  let nativeEntry = $derived(target?.kind === 'native' ? target.entry : null)
  let editingRegistry = $derived(target?.kind === 'registry' ? target.utility : null)

  let availableHarnesses = $derived(
    providerStore.providers
      .filter((provider) => provider.integration === 'ready' && provider.status === 'available')
      .map((provider) => ({ id: provider.id, name: provider.name }))
  )
  let scopedThreads = $derived(
    threads.filter(
      (thread) =>
        thread.projectId === draft.projectId &&
        !thread.archived &&
        !isOrchestrationChildThread(thread)
    )
  )
  let projectOptions = $derived.by((): ScopeProject[] => {
    const options = projects.map((project) => ({
      id: project.id,
      name: project.name,
      iconUrl: getProjectIcon(project, projectIconUrls[project.id]),
      color: project.color ?? pickColorForSeed(project.id)
    }))
    if (draft.projectId && !options.some((project) => project.id === draft.projectId)) {
      options.unshift({
        id: draft.projectId,
        name: 'Unavailable project',
        iconUrl: null,
        color: pickColorForSeed(draft.projectId)
      })
    }
    return options
  })
  let selectedScopeProject = $derived(
    projectOptions.find((project) => project.id === draft.projectId) ?? null
  )
  let editedUtility = $derived(
    draft.id ? utilities.find((utility) => utility.id === draft.id) : undefined
  )

  let title = $derived.by(() => {
    if (isNative) return `Edit ${nativeEntry?.name ?? 'capability'}`
    if (draft.id) return 'Edit utility'
    if (setupPreset) return 'Configure capability'
    return 'Add capability'
  })

  function emptyDraft(): UtilityDraft {
    return {
      id: null,
      kind: 'mcp',
      name: '',
      description: '',
      enabled: true,
      activation: 'on_demand',
      scopeLevel: 'global',
      projectId: '',
      threadId: '',
      transport: 'stdio',
      command: '',
      args: '',
      url: '',
      environment: '',
      instructions: '',
      supportingFiles: '',
      endpoint: '',
      headers: '',
      provider: 'custom',
      backend: '',
      providerId: '',
      defaultModel: '',
      descriptorHarnessId: '',
      descriptorProviderId: '',
      descriptorModelId: '',
      bindings: []
    }
  }

  function resetCredential(): void {
    credentialId = ''
    credentialLabel = ''
    credentialValue = ''
    credentialRequired = false
    credentialEnvironmentVariable = ''
  }

  function skillDocument(name: string, description: string, instructions: string): string {
    if (instructions.trimStart().startsWith('---')) return instructions
    return `---
name: ${name}
description: ${description || 'Describe when an agent should use this skill.'}
---

${instructions}`
  }

  function skillMetadata(markdown: string): { name: string; description: string } {
    const match = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u)
    if (!match?.[1]) {
      throw new Error('SKILL.md must begin with frontmatter containing name and description.')
    }
    const fields: Record<string, string> = {}
    for (const line of match[1].split('\n')) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
    }
    const name = fields['name'] ?? ''
    const description = fields['description'] ?? ''
    if (!name) throw new Error('SKILL.md frontmatter requires a name.')
    if (!description) throw new Error('SKILL.md frontmatter requires a description.')
    return { name, description }
  }

  function bindings(
    strategy: BindingStrategy,
    nativeCapability: string,
    transportName: string
  ): BindingDraft[] {
    return availableHarnesses.map((harness) => ({
      harnessId: harness.id,
      strategy,
      nativeCapability,
      transportName
    }))
  }

  function toggleHarness(harnessId: string): void {
    const existing = draft.bindings.find((binding) => binding.harnessId === harnessId)
    if (existing) {
      draft.bindings = draft.bindings.filter((binding) => binding.harnessId !== harnessId)
      return
    }
    const strategy: BindingStrategy =
      draft.kind === 'skill' ? 'skill' : draft.kind === 'image_descriptor' ? 'native' : 'mcp'
    draft.bindings = [
      ...draft.bindings,
      {
        harnessId,
        strategy,
        nativeCapability:
          draft.kind === 'web_search' || draft.kind === 'web_fetch'
            ? draft.kind
            : draft.kind === 'image_descriptor'
              ? 'image_descriptor'
              : '',
        transportName:
          draft.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, '-')
            .replace(/^-|-$/gu, '') || 'utility'
      }
    ]
  }

  function setScopeLevel(level: ScopeLevel): void {
    draft.scopeLevel = level
    if (level === 'global') {
      draft.projectId = ''
      draft.threadId = ''
    } else if (level === 'project') {
      draft.threadId = ''
    }
  }

  function setScopeProject(projectId: string): void {
    draft.projectId = projectId
    draft.threadId = ''
  }

  function choosePreset(id: string): void {
    setupPreset = id
    draft = emptyDraft()
    resetCredential()
    editorError = ''
    if (id === 'plugin-bundle') return
    if (id === 'svelte-mcp') {
      draft.kind = 'mcp'
      draft.name = 'Svelte MCP'
      draft.description = 'Current Svelte and SvelteKit documentation and code assistance.'
      draft.transport = 'http'
      draft.url = 'https://mcp.svelte.dev/mcp'
      draft.bindings = bindings('mcp', 'svelte_mcp', 'svelte')
    } else if (id === 'convex-mcp') {
      draft.kind = 'mcp'
      draft.name = 'Convex MCP'
      draft.description = 'Project-aware Convex deployment, schema, function, and data tools.'
      draft.transport = 'stdio'
      draft.command = 'bunx'
      draft.args = ['convex@latest', 'mcp', 'start'].join('\n')
      draft.bindings = bindings('mcp', 'convex_mcp', 'convex')
    } else if (id === 'convex-skill') {
      draft.kind = 'skill'
      draft.instructions = `---
name: convex
description: Convex implementation guidance and project conventions.
---

# Convex

Use current Convex conventions when working in a Convex project.

## Workflow

- Inspect the schema and generated API before editing functions.
- Use explicit argument and return validators.
- Enforce authorization in public functions.
- Prefer indexed queries over filtering.
- Keep Node-only work in actions.
- Run the project's scoped Convex and TypeScript checks after changes.`
      draft.bindings = bindings('skill', 'convex_skill', 'convex')
    } else if (id === 'exa-search' || id === 'exa-fetch') {
      const search = id === 'exa-search'
      draft.kind = search ? 'web_search' : 'web_fetch'
      draft.provider = 'exa'
      draft.name = search ? 'Exa Search' : 'Exa Contents'
      draft.description = search
        ? 'Search the web with Exa.'
        : 'Retrieve clean page contents through Exa.'
      draft.endpoint = search ? 'https://api.exa.ai/search' : 'https://api.exa.ai/contents'
      draft.headers = JSON.stringify({ 'x-api-key': '{env:EXA_API_KEY}' }, null, 2)
      draft.bindings = bindings(
        'mcp',
        search ? 'web_search' : 'web_fetch',
        search ? 'exa-search' : 'exa-fetch'
      )
      credentialId = 'api-key'
      credentialLabel = 'Exa API key'
      credentialEnvironmentVariable = 'EXA_API_KEY'
      credentialRequired = true
    } else if (id === 'firecrawl-skill') {
      draft.kind = 'skill'
      draft.name = 'Firecrawl'
      draft.description =
        'Firecrawl web context skills for agents: search, scrape, interact, parse, research, and monitoring.'
      draft.instructions = `---
name: firecrawl
description: |
  Firecrawl gives AI agents and apps fast, reliable web context with
  strong search, scraping, interaction, document parsing, research,
  and monitoring tools. One install command sets up three skill
  segments: live CLI tools, app-integration build skills, and
  outcome-focused workflow skills. Route the reader to the right
  usage path after install.
---

# Firecrawl

Firecrawl helps agents search first, scrape clean content, interact
with live pages when plain extraction is not enough, parse local
documents into markdown, search scientific papers and GitHub history
through the research index, monitor pages for changes, and produce
finished deliverables from web data.

## Install

One command installs everything — the Firecrawl CLI for live web work,
the build skills for integrating Firecrawl into application code, **and**
the workflow skills for producing repeatable deliverables. It also opens
browser auth so the human can sign in or create an account.

\`\`\`bash
npx -y firecrawl-cli@latest init --all --browser
\`\`\`

This gives you:

- **CLI tools** — \`firecrawl search\`, \`firecrawl scrape\`, \`firecrawl interact\`, \`firecrawl parse\`, \`firecrawl monitor\`, \`firecrawl research\`, \`firecrawl ask\`, \`firecrawl docs-search\`, and more
- **CLI skills** — teach the agent how to drive the Firecrawl CLI during its own session: which command to run, when to scrape vs search vs interact, how to chain results, and how to recover when a job fails. Use these when the agent itself needs web data right now.
- **Build skills** — teach the agent how to add Firecrawl to a product's codebase: pick the right API endpoint, install the matching SDK, store \`FIRECRAWL_API_KEY\` safely, write the call site to match the project's conventions, and ship a smoke-tested integration. Use these when the agent is shipping code that other people will run, not running the agent's own web tools.
- **Workflow skills** — turn Firecrawl web data into finished deliverables such as research briefs, SEO audits, lead lists, QA reports, knowledge bases, and design clones. Use these when the agent's job is to produce a finished artifact, not raw extraction or product code.
- **Browser auth** — walks the human through sign-in or account creation

Before doing real work, verify the install:

\`\`\`bash
mkdir -p .firecrawl
firecrawl --status
firecrawl scrape "https://firecrawl.dev" -o .firecrawl/install-check.md
\`\`\`

## Get Credentials

Firecrawl users can get an API key in two ways:

- **Dashboard or CLI (default)** — browser sign-in, CLI \`--browser\` auth,
  install skills/MCP, or create an API key in the dashboard. Continue
  with Path D below, or run the install command first.
- **WorkOS ID-JAG (supported agent platforms only)** — if your platform
  can mint a WorkOS ID-JAG identity assertion, fetch
  \`https://www.firecrawl.dev/auth.md\` and follow it end-to-end. Do not
  run the browser or CLI auth flow in Path D.

Human-readable overview:
https://docs.firecrawl.dev/ai-onboarding#get-credentials

## Choose Your Path

All paths use the same install above. The difference is what you do
next.

- **Need web data during this session** -> Path A (live tools)
- **Need to add Firecrawl to app code** -> Path B (app integration)
- **Need a finished deliverable from web data** -> Path C (workflow skills)
- **Need more than one of the above** -> do them in sequence; the install already covers everything
- **Agent platform with WorkOS ID-JAG** -> see Get Credentials above (not Path D)
- **Need an account or API key (browser or CLI)** -> Path D
- **Don't want to install anything** -> Path E (REST API directly)
- **No API key and the human cannot sign up right now** -> Path F (keyless free tier, fallback)

---

## Path A: Live Web Tools

Use this when you need web data during your work: searching the web,
scraping known URLs, interacting with live pages, crawling docs,
mapping a site, parsing local documents, searching research papers,
or monitoring pages for changes.

After install, hand off to the CLI skill. Default flow for live web work:

1. start with search when you need discovery
2. move to scrape when you have a URL
3. use interact only when the page needs clicks, forms, or login
4. use parse when the source is a local file instead of a URL
5. use monitor when the request implies recurrence or notifications ("alert me when", "track this page") rather than a one-time read
6. if any step fails or returns unexpected output, run \`firecrawl ask\` with the failing \`jobId\` instead of guessing

If the task becomes "wire Firecrawl into product code," switch to Path B.

---

## Path B: Integrate Firecrawl Into an App

Use this when you're building an application, agent, or workflow that
calls the Firecrawl API **from code** — meaning the integration will run
inside the user's product (a web app, backend service, script, agent
loop, or pipeline) rather than from the agent's own terminal session.

Save the key to the project's environment:

\`\`\`dotenv
FIRECRAWL_API_KEY=fc-...
\`\`\`

The required question in the build path is:

- **What should Firecrawl do in the product?**

Use the answer to route to \`/search\`, \`/scrape\`, \`/interact\`, \`/parse\`, \`/crawl\`, \`/map\`, \`/monitor\`, or the research index, then run one real Firecrawl request as a smoke test.

If you do not have a key yet, do Path D first.

---

## Path C: Repeatable Deliverables

Use this when the goal is a finished artifact powered by Firecrawl web
data — a research brief, SEO audit, QA report, lead list, knowledge
base, competitive intel digest, or a cloned design system — not raw web
extraction and not product-code integration.

Workflow skills infer from context first and only ask short clarifying
questions when an input would block the work.

Default flow for workflow deliverables:

1. confirm the workflow and final artifact with the user
2. collect web evidence with Firecrawl through the CLI or equivalent tool surface
3. save or cite source evidence so claims are traceable
4. run independent research units in parallel when available
5. synthesize findings into the requested deliverable
6. include a short "rerun inputs" block when the workflow could be automated

If the underlying web work fails or the request shifts to "wire Firecrawl into product code," switch to Path A or Path B.

---

## Path D: Account Authorization Or API Key

Use this when the human still needs to sign up, sign in, authorize
access, or obtain an API key.

If you already have a valid \`FIRECRAWL_API_KEY\`, skip this path.

If you're the human reading this in the browser, create an account or
sign in at:

- https://www.firecrawl.dev/signin?view=signup&source=agent-suggested

If you're an agent and need the human to authorize an API key, use this
flow:

**Step 1 — Generate auth parameters:**

\`\`\`bash
SESSION_ID=$(openssl rand -hex 32)
CODE_VERIFIER=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\\n' | head -c 43)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
\`\`\`

**Step 2 — Ask the human to open this URL:**

\`\`\`
https://www.firecrawl.dev/cli-auth?code_challenge=$CODE_CHALLENGE&source=coding-agent#session_id=$SESSION_ID
\`\`\`

**Step 3 — Poll for the API key:**

\`\`\`bash
POST https://www.firecrawl.dev/api/auth/cli/status
Content-Type: application/json

{"session_id": "$SESSION_ID", "code_verifier": "$CODE_VERIFIER"}
\`\`\`

Poll every 3 seconds. Responses:

- \`{"status": "pending"}\` — keep polling
- \`{"status": "complete", "apiKey": "fc-...", "teamName": "..."}\` — done

**Step 4 — Save the key and continue:**

\`\`\`bash
echo "FIRECRAWL_API_KEY=fc-..." >> .env
\`\`\`

---

## Path E: Use Firecrawl Without Installing Anything

Use this when you don't want to install a CLI or skills package.

**Base URL:** \`https://api.firecrawl.dev/v2\`

**Auth header:** \`Authorization: Bearer fc-YOUR_API_KEY\`

### Available endpoints

- \`POST /search\` — discover pages by query
- \`POST /scrape\` — extract clean markdown from a single URL
- \`POST /interact\` — browser actions on live pages (clicks, forms, navigation)
- \`POST /parse\` — upload a local or non-public document as \`multipart/form-data\` and get back markdown, JSON, HTML, links, images, or a summary. Use \`/scrape\` when the document has a public URL
- \`POST /monitor\` — create a recurring check that watches pages, diffs each check against the last snapshot, optionally judges changes against a plain-language \`goal\`, and notifies by webhook, email, or Slack
- \`GET /search/research/papers\` — search a scientific paper index by natural-language query; \`GET /search/research/github\` searches GitHub issues, PRs, discussions, and READMEs
- \`POST /support/ask\` — diagnose a failing Firecrawl call
- \`POST /support/docs-search\` — answer "how do I…" questions from Firecrawl's official docs

### Documentation and references

- **API reference:** https://docs.firecrawl.dev
- **Skills repo:** https://github.com/firecrawl/skills

---

## Path F: Keyless Free Tier (Fallback)

Use this when you need Firecrawl right now and cannot obtain an API key,
for example when the human is not available to sign up.

- **MCP**: point any MCP-compatible client at \`https://mcp.firecrawl.dev/v2/mcp\`
- **CLI**: run \`npx -y firecrawl-cli@latest\` and use \`scrape\`, \`search\`, \`interact\`, or \`parse\` with no login
- **API**: the research index endpoints (\`/search/research/*\`) can be called without an \`Authorization\` header

Search, scrape, interact, parse, and the research index are available
keyless. Crawl, map, monitor, extract, batch scrape, agent, and other
endpoints still require an API key.

Prefer a free account when the human can sign up: do Path D to get an
account or API key, which unlocks higher limits and the full set of
endpoints. If you hit rate limits on the keyless free tier, ask the human
to sign up at https://www.firecrawl.dev/signin.`
      draft.bindings = bindings('skill', 'firecrawl', 'firecrawl')
    } else if (id === 'brave-search') {
      draft.kind = 'web_search'
      draft.provider = 'brave'
      draft.name = 'Brave Search'
      draft.description = 'Search the web with Brave Search.'
      draft.endpoint = 'https://api.search.brave.com/res/v1/web/search'
      draft.headers = JSON.stringify({ 'X-Subscription-Token': '{env:BRAVE_API_KEY}' }, null, 2)
      draft.bindings = bindings('mcp', 'web_search', 'brave-search')
      credentialId = 'api-key'
      credentialLabel = 'Brave Search API key'
      credentialEnvironmentVariable = 'BRAVE_API_KEY'
      credentialRequired = true
    } else if (id === 'custom-mcp') {
      draft.kind = 'mcp'
      draft.bindings = bindings('mcp', '', 'custom-mcp')
    } else if (id === 'image-descriptor') {
      draft.kind = 'image_descriptor'
      draft.name = 'Image descriptor'
      draft.description =
        'Describes attached images with a vision model so text-only models can reason about them.'
      draft.descriptorHarnessId = 'opencode'
      draft.bindings = bindings('native', 'image_descriptor', 'image-descriptor')
    } else if (id === 'custom-skill') {
      draft.kind = 'skill'
      draft.instructions = `---
name: my-skill
description: Explain when an agent should use this skill.
---

# Instructions

Write the complete workflow, rules, and examples for this skill.`
      draft.bindings = bindings('skill', '', 'custom-skill')
    } else {
      draft.kind = 'web_search'
      draft.headers = JSON.stringify({ Authorization: 'Bearer {env:WEB_API_KEY}' }, null, 2)
      draft.bindings = bindings('mcp', 'web_search', 'custom-web')
      credentialId = 'api-key'
      credentialLabel = 'Web API key'
      credentialEnvironmentVariable = 'WEB_API_KEY'
      credentialRequired = true
    }
  }

  function parseRecord(value: string, label: string): Record<string, string> | undefined {
    if (!value.trim()) return undefined
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`)
    }
    const result: Record<string, string> = {}
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item !== 'string') throw new Error(`${label} values must be strings.`)
      result[key] = item
    }
    return result
  }

  function buildScope(): UtilityScope {
    if (draft.scopeLevel === 'global') return { level: 'global' }
    if (!draft.projectId.trim()) throw new Error('Project ID is required.')
    if (draft.scopeLevel === 'project') {
      return { level: 'project', projectId: draft.projectId.trim() }
    }
    if (!draft.threadId.trim()) throw new Error('Thread ID is required.')
    return {
      level: 'thread',
      projectId: draft.projectId.trim(),
      threadId: draft.threadId.trim()
    }
  }

  function buildConfig(): UtilityConfigMap[UtilityKind] {
    switch (draft.kind) {
      case 'mcp': {
        const environment = parseRecord(draft.environment, 'Environment')
        const headers = parseRecord(draft.headers, 'Headers')
        return {
          transport: draft.transport,
          ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
          ...(draft.args.trim()
            ? {
                args: draft.args
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean)
              }
            : {}),
          ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
          ...(environment ? { environment } : {}),
          ...(headers ? { headers } : {})
        }
      }
      case 'skill':
        return { instructions: draft.instructions.trim() }
      case 'web_search':
      case 'web_fetch': {
        const headers = parseRecord(draft.headers, 'Headers')
        return {
          ...(draft.provider !== 'custom' ? { provider: draft.provider } : {}),
          ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
          ...(headers ? { headers } : {})
        }
      }
      case 'computer_use':
        return {
          backend: draft.backend.trim(),
          ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {})
        }
      case 'provider':
        return {
          providerId: draft.providerId.trim(),
          ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
          ...(draft.defaultModel.trim() ? { defaultModel: draft.defaultModel.trim() } : {})
        }
      case 'image_descriptor':
        return {
          harnessId: draft.descriptorHarnessId.trim(),
          providerId: draft.descriptorProviderId.trim(),
          modelId: draft.descriptorModelId.trim()
        }
    }
  }

  function buildBindings(): HarnessUtilityBinding[] {
    const installedIds = new Set(availableHarnesses.map((harness) => harness.id))
    return draft.bindings
      .filter((binding) => binding.harnessId.trim())
      .filter((binding) => draft.id !== null || installedIds.has(binding.harnessId))
      .map((binding) => ({
        harnessId: binding.harnessId.trim(),
        strategy: binding.strategy,
        ...(binding.nativeCapability.trim()
          ? { nativeCapability: binding.nativeCapability.trim() }
          : {}),
        ...(binding.transportName.trim() ? { transportName: binding.transportName.trim() } : {})
      }))
  }

  function buildCredential(): UtilityCredentialInput | null {
    if (!credentialValue) return null
    const webUtility = draft.kind === 'web_search' || draft.kind === 'web_fetch'
    const environmentVariable =
      credentialEnvironmentVariable.trim() || (webUtility ? 'WEB_API_KEY' : '')
    if (!environmentVariable) throw new Error('Environment variable is required for an MCP secret.')
    const id =
      credentialId.trim() ||
      environmentVariable
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '')
    const label =
      credentialLabel.trim() || (webUtility ? 'Web API key' : `${environmentVariable} secret`)
    return {
      id,
      label,
      value: credentialValue,
      required: credentialRequired,
      environmentVariable
    }
  }

  function openRegistryEdit(utility: UtilityDefinition): void {
    const next = emptyDraft()
    next.id = utility.id
    next.kind = utility.kind
    next.name = utility.name
    next.description = utility.description
    next.enabled = utility.enabled
    next.activation = utility.activation
    next.scopeLevel = utility.scope.level
    next.projectId = utility.scope.level === 'global' ? '' : utility.scope.projectId
    next.threadId = utility.scope.level === 'thread' ? utility.scope.threadId : ''
    next.bindings = utility.harnessBindings.map((binding) => ({
      harnessId: binding.harnessId,
      strategy: binding.strategy,
      nativeCapability: binding.nativeCapability ?? '',
      transportName: binding.transportName ?? ''
    }))
    switch (utility.kind) {
      case 'mcp':
        next.transport = utility.config.transport
        next.command = utility.config.command ?? ''
        next.args = utility.config.args?.join('\n') ?? ''
        next.url = utility.config.url ?? ''
        next.environment = utility.config.environment
          ? JSON.stringify(utility.config.environment, null, 2)
          : ''
        next.headers = utility.config.headers ? JSON.stringify(utility.config.headers, null, 2) : ''
        break
      case 'skill':
        next.instructions = skillDocument(
          utility.name,
          utility.description,
          utility.config.instructions
        )
        next.supportingFiles = utility.config.supportingFiles?.join('\n') ?? ''
        break
      case 'web_search':
      case 'web_fetch':
        next.provider = utility.config.provider ?? 'custom'
        next.endpoint = utility.config.endpoint ?? ''
        next.headers = utility.config.headers ? JSON.stringify(utility.config.headers, null, 2) : ''
        break
      case 'computer_use':
        next.backend = utility.config.backend
        next.endpoint = utility.config.endpoint ?? ''
        break
      case 'provider':
        next.providerId = utility.config.providerId
        next.endpoint = utility.config.endpoint ?? ''
        next.defaultModel = utility.config.defaultModel ?? ''
        break
      case 'image_descriptor':
        next.descriptorHarnessId = utility.config.harnessId
        next.descriptorProviderId = utility.config.providerId
        next.descriptorModelId = utility.config.modelId
        break
    }
    draft = next
    resetCredential()
    const storedCredential = utility.credentials[0]
    if (storedCredential) {
      credentialId = storedCredential.id
      credentialLabel = storedCredential.label
      credentialRequired = storedCredential.required
      credentialEnvironmentVariable = storedCredential.environmentVariable ?? ''
    }
    editorError = ''
    setupPreset = null
  }

  async function openNative(): Promise<void> {
    const entry = nativeEntry
    if (!entry) return
    loadingNative = true
    editorError = ''
    const next = emptyDraft()
    try {
      if (entry.kind === 'skill') {
        const content = await invoke('capabilities:readSkill', entry.source)
        if (!content) throw new Error('The skill file could not be read.')
        next.kind = 'skill'
        next.name = content.name
        next.description = content.description
        next.instructions = content.instructions
      } else {
        const content = await invoke('capabilities:readMcp', entry.source)
        if (!content) throw new Error('The MCP server configuration could not be read.')
        next.kind = 'mcp'
        next.name = content.name
        next.enabled = content.enabled
        next.transport = content.transport
        next.command = content.command ?? ''
        next.args = content.args?.join('\n') ?? ''
        next.url = content.url ?? ''
        next.environment = content.environment ? JSON.stringify(content.environment, null, 2) : ''
        next.headers = content.headers ? JSON.stringify(content.headers, null, 2) : ''
      }
      draft = next
      resetCredential()
      setupPreset = null
    } catch (error) {
      editorError = error instanceof Error ? error.message : 'The capability could not be loaded.'
    } finally {
      loadingNative = false
    }
  }

  async function loadContext(): Promise<void> {
    const [catalog, nextProjects, nextThreads] = await Promise.all([
      invoke('utilities:list'),
      invoke('project:list'),
      invoke('thread:listAll')
    ])
    utilities = catalog.utilities
    secureStorageAvailable = catalog.secureStorageAvailable
    projects = nextProjects.filter((project) => !project.hidden)
    threads = nextThreads
    projectIconUrls = Object.fromEntries(await loadProjectIcons(projects))
  }

  $effect(() => {
    if (!open) return
    if (target?.kind === 'registry') {
      draft = emptyDraft()
      resetCredential()
      setupPreset = null
      pluginManifest = ''
      editorError = ''
      if (target.utility) openRegistryEdit(target.utility)
    } else if (target?.kind === 'native') {
      void openNative()
    }
  })

  onMount(() => {
    void loadContext()
    void providerStore.init()
  })

  async function saveRegistryUtility(): Promise<void> {
    const metadata =
      draft.kind === 'skill'
        ? skillMetadata(draft.instructions)
        : { name: draft.name.trim(), description: draft.description.trim() }
    if (!metadata.name) throw new Error('Name is required.')
    if (draft.id === null && buildBindings().length === 0) {
      throw new Error('Select at least one installed harness.')
    }
    const common = {
      name: metadata.name,
      description: metadata.description,
      enabled: draft.enabled,
      activation: draft.activation,
      scope: buildScope(),
      config: buildConfig(),
      harnessBindings: buildBindings()
    }
    let saved: UtilityDefinition
    if (draft.id) {
      const patch: UtilityDefinitionPatch = common
      saved = await invoke('utilities:update', draft.id, patch)
      const credential = buildCredential()
      if (credential) saved = await invoke('utilities:setCredential', saved.id, credential)
    } else {
      const input: UtilityDefinitionInput = { kind: draft.kind, ...common }
      const credential = buildCredential()
      const [installed] = await invoke('utilities:installBundle', {
        name: input.name,
        utilities: [
          {
            definition: input,
            ...(credential ? { credentials: [credential] } : {})
          }
        ]
      })
      if (!installed) throw new Error('The utility was not installed.')
      saved = installed
    }
    onSaved?.(saved)
    onChanged?.()
    onClose()
  }

  async function saveNative(): Promise<void> {
    const entry = nativeEntry
    if (!entry) return
    if (entry.kind === 'skill') {
      if (!draft.instructions.trim()) throw new Error('Skill instructions are required.')
      await invoke('capabilities:updateSkill', entry.source, draft.instructions.trim())
    } else {
      const content: NativeMcpContent = {
        name: draft.name.trim(),
        transport: draft.transport,
        command: draft.command.trim() || undefined,
        args: draft.args
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        url: draft.url.trim() || undefined,
        environment: parseRecord(draft.environment, 'Environment'),
        headers: parseRecord(draft.headers, 'Headers'),
        enabled: draft.enabled,
        configPath: entry.source.kind === 'mcp' ? entry.source.configPath : ''
      }
      await invoke('capabilities:updateMcp', entry.source, content)
    }
    onChanged?.()
    onClose()
  }

  async function saveUtility(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    saving = true
    editorError = ''
    try {
      if (isNative) {
        await saveNative()
      } else {
        await saveRegistryUtility()
      }
    } catch (saveError) {
      editorError =
        saveError instanceof Error ? saveError.message : 'The capability could not be saved.'
    } finally {
      saving = false
    }
  }

  async function deleteUtility(): Promise<void> {
    if (!deleteTarget) return
    const entry = deleteTarget
    saving = true
    editorError = ''
    try {
      if (entry.kind === 'native') {
        if (entry.entry.kind === 'skill') {
          await invoke('capabilities:deleteSkill', entry.entry.source)
        } else {
          await invoke('capabilities:deleteMcp', entry.entry.source)
        }
      } else {
        const utility = entry.utility
        if (utility) await invoke('utilities:delete', utility.id)
      }
      deleteTarget = null
      onChanged?.()
      onClose()
    } catch (deleteError) {
      editorError =
        deleteError instanceof Error ? deleteError.message : 'The capability could not be deleted.'
    } finally {
      saving = false
    }
  }

  async function removeCredential(utilityId: string, id: string): Promise<void> {
    editorError = ''
    try {
      const updated = await invoke('utilities:removeCredential', utilityId, id)
      utilities = utilities.map((utility) => (utility.id === updated.id ? updated : utility))
      openRegistryEdit(updated)
    } catch (removeError) {
      editorError =
        removeError instanceof Error ? removeError.message : 'The credential could not be removed.'
    }
  }

  async function readPluginFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file) pluginManifest = await file.text()
  }

  async function importPluginBundle(): Promise<void> {
    saving = true
    editorError = ''
    try {
      const parsed: unknown = JSON.parse(pluginManifest)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The plugin manifest must be a JSON object.')
      }
      await invoke('utilities:installBundle', parsed as UtilityBundleInstallRequest)
      onChanged?.()
      onClose()
    } catch (installError) {
      editorError =
        installError instanceof Error ? installError.message : 'The plugin could not be installed.'
    } finally {
      saving = false
    }
  }
</script>

{#if open}
  <Modal open {title} size="xl" {onClose}>
    {#if loadingNative}
      <div class="flex items-center justify-center p-10">
        <Loader2 size={18} class="animate-spin text-dimmed" />
      </div>
    {:else if !isNative && draft.id === null && setupPreset === null}
      <div>
        <div class="mb-5 rounded-xl bg-raised p-4">
          <p class="text-sm font-semibold">What should agents be able to do?</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            Choose a ready-to-use connection or build your own. CodeInOven handles harness wiring,
            secure credentials, and turn-scoped activation.
          </p>
        </div>
        {#each ['Ready to use', 'Build your own'] as group (group)}
          <section class="mb-6">
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{group}</h3>
            <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {#each (target?.kind === 'registry' && target.utility === null ? registryPresets : []).filter((preset) => preset.group === group) as preset (preset.id)}
                <button
                  type="button"
                  class="group min-h-28 rounded-xl border bg-elevated p-4 text-left transition-colors hover:border-primary hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onclick={() => choosePreset(preset.id)}
                >
                  <span class="flex items-start justify-between gap-3">
                    <span
                      class="flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-muted group-hover:text-foreground"
                    >
                      {#if preset.badge === 'MCP'}
                        <Server size={16} />
                      {:else if preset.badge === 'Skill'}
                        <BookOpen size={16} />
                      {:else if preset.badge === 'Plugin'}
                        <Boxes size={16} />
                      {:else}
                        <Globe2 size={16} />
                      {/if}
                    </span>
                    <span
                      class="rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted"
                    >
                      {preset.badge}
                    </span>
                  </span>
                  <span class="mt-3 block text-sm font-semibold">{preset.title}</span>
                  <span class="mt-1 block text-xs leading-relaxed text-muted">
                    {preset.description}
                  </span>
                </button>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {:else if !isNative && draft.id === null && setupPreset === 'plugin-bundle'}
      <div>
        <button
          type="button"
          class="mb-4 flex h-8 items-center gap-1.5 rounded-lg text-xs font-medium text-muted hover:text-foreground"
          onclick={() => (setupPreset = null)}
        >
          <ChevronLeft size={14} /> Choose another capability
        </button>
        {#if editorError}
          <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {editorError}
          </p>
        {/if}
        <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div>
            <div class="rounded-xl border border-dashed bg-elevated p-5">
              <Upload size={20} class="mb-3 text-muted" />
              <p class="text-sm font-semibold">Import a plugin manifest</p>
              <p class="mt-1 text-xs leading-relaxed text-muted">
                A plugin bundle can install several MCP servers, skills, and web utilities together.
                Installation is atomic: if one entry is invalid, nothing is added.
              </p>
              <label
                class="mt-4 inline-flex h-9 cursor-pointer items-center rounded-lg border bg-surface px-3 text-xs font-medium hover:bg-overlay"
              >
                Choose JSON file
                <input
                  class="sr-only"
                  type="file"
                  accept=".json,application/json"
                  onchange={readPluginFile}
                />
              </label>
            </div>
            <label class="mt-4 block space-y-1 text-xs font-medium">
              <span>Or paste the manifest</span>
              <textarea
                class="min-h-64 w-full resize-y rounded-xl border bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                placeholder={'{\n  "name": "My plugin",\n  "utilities": [\n    { "definition": { ... }, "credentials": [] }\n  ]\n}'}
                bind:value={pluginManifest}></textarea>
            </label>
          </div>
          <aside class="rounded-xl bg-raised p-4">
            <p class="text-xs font-semibold uppercase tracking-wide text-muted">Plugin format</p>
            <ul class="mt-3 space-y-2 text-xs leading-relaxed text-muted">
              <li>One manifest can contain MCP, skill, web search, and web fetch entries.</li>
              <li>Each entry uses the same fields as a single installed capability.</li>
              <li>Secret values are moved into secure storage and never returned to the UI.</li>
              <li>All entries are validated before the registry changes.</li>
            </ul>
          </aside>
        </div>
      </div>
    {:else}
      <form id="utility-editor-form" class="space-y-4" onsubmit={saveUtility}>
        {#if editorError}
          <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {editorError}
          </p>
        {/if}

        {#if isNative && nativeEntry?.kind === 'skill'}
          <p class="rounded-lg bg-raised px-3 py-2 text-[11px] text-muted">
            Editing the skill file at <span class="font-mono"
              >{nativeEntry.source.kind === 'skill' ? nativeEntry.source.path : ''}</span
            >.
          </p>
        {/if}
        {#if isNative && nativeEntry?.kind === 'mcp'}
          <p class="rounded-lg bg-raised px-3 py-2 text-[11px] text-muted">
            Editing the MCP server in
            <span class="font-mono">
              {nativeEntry.source.kind === 'mcp' ? nativeEntry.source.configPath : ''}
            </span>.
          </p>
        {/if}

        {#if !isNative}
          {@render harnessSelector()}
        {/if}

        {#if draft.kind !== 'skill'}
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="space-y-1 text-xs font-medium">
              <span>Name</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                required
                bind:value={draft.name}
              />
            </label>
            <label class="space-y-1 text-xs font-medium">
              <span>Description</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                bind:value={draft.description}
              />
            </label>
          </div>
        {/if}

        {#if !isNative}
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-xs font-medium">
              <span>Activation</span>
              <select
                class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
                bind:value={draft.activation}
              >
                <option value="on_demand">On demand</option>
                <option value="always">Always available</option>
              </select>
            </label>
            <label class="space-y-1 text-xs font-medium">
              <span>Scope</span>
              <select
                class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
                value={draft.scopeLevel}
                onchange={(event: Event) =>
                  setScopeLevel((event.currentTarget as HTMLSelectElement).value as ScopeLevel)}
              >
                <option value="global">Global</option>
                <option value="project">Project</option>
                <option value="thread">Thread</option>
              </select>
            </label>
          </div>
          {#if draft.scopeLevel !== 'global'}
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-xs font-medium">
                <span>Project</span>
                <ProjectSelect
                  projects={projectOptions}
                  value={draft.projectId}
                  onValueChange={setScopeProject}
                  ariaLabel="Select utility project"
                  placeholder="Select a project"
                  searchPlaceholder="Search projects…"
                  emptyMessage="No projects match this search"
                />
              </label>
              {#if draft.scopeLevel === 'thread'}
                <label class="space-y-1 text-xs font-medium">
                  <span>Thread</span>
                  <ThreadSelect
                    threads={scopedThreads}
                    project={selectedScopeProject}
                    value={draft.threadId}
                    onValueChange={(threadId) => (draft.threadId = threadId)}
                    ariaLabel="Select utility thread"
                    placeholder="Select a thread"
                    searchPlaceholder="Search this project's threads…"
                    emptyMessage={draft.projectId
                      ? 'No threads match this search'
                      : 'Select a project first'}
                    disabled={!draft.projectId}
                  />
                </label>
              {/if}
            </div>
          {/if}
        {/if}

        <fieldset class="space-y-3 rounded-xl border p-3">
          <legend class="px-1 text-xs font-semibold">
            {draft.kind === 'skill'
              ? 'SKILL.md'
              : draft.kind === 'mcp'
                ? 'MCP connection'
                : draft.kind === 'web_search' || draft.kind === 'web_fetch'
                  ? 'Web connection'
                  : draft.kind === 'computer_use'
                    ? 'Computer-use backend'
                    : draft.kind === 'image_descriptor'
                      ? 'Image descriptor model'
                      : 'Provider connection'}
          </legend>
          {#if draft.kind === 'mcp'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Transport</span>
              <select
                class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
                bind:value={draft.transport}
              >
                <option value="stdio">stdio</option>
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </label>
            {#if draft.transport === 'stdio'}
              <label class="block space-y-1 text-xs font-medium">
                <span>Command</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                  bind:value={draft.command}
                />
              </label>
              <label class="block space-y-1 text-xs font-medium">
                <span>Arguments · one per line</span>
                <textarea
                  class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                  bind:value={draft.args}></textarea>
              </label>
            {:else}
              <label class="block space-y-1 text-xs font-medium">
                <span>URL</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                  type="url"
                  bind:value={draft.url}
                />
              </label>
            {/if}
            {#if draft.transport !== 'stdio'}
              <label class="block space-y-1 text-xs font-medium">
                <span>Request headers</span>
                <textarea
                  class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                  placeholder={'{ "Authorization": "Bearer {env:API_TOKEN}" }'}
                  bind:value={draft.headers}></textarea>
              </label>
            {/if}
            {#if isNative || draft.id !== null}
              <label class="block space-y-1 text-xs font-medium">
                <span>Environment</span>
                <textarea
                  class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                  placeholder={'{ "NODE_ENV": "production" }'}
                  bind:value={draft.environment}></textarea>
              </label>
            {/if}
          {:else if draft.kind === 'skill'}
            <RichMarkdownEditor
              id="utility-skill-markdown"
              bind:value={draft.instructions}
              placeholder={skillPlaceholder}
              ariaLabel="Skill Markdown"
              containerClass="rounded-xl border bg-elevated focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
              class="min-h-72 max-h-96 w-full resize-y overflow-y-auto px-4 py-3 text-sm leading-6 text-foreground outline-none"
            />
            <p class="text-[11px] text-dimmed">
              Write the complete skill file, including frontmatter and instruction sections. The
              frontmatter name and description identify the installed skill.
            </p>
          {:else if draft.kind === 'web_search' || draft.kind === 'web_fetch'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Endpoint</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                type="url"
                bind:value={draft.endpoint}
              />
            </label>
            <label class="block space-y-1 text-xs font-medium">
              <span>Request headers</span>
              <textarea
                class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                placeholder={'{ "Authorization": "Bearer {env:WEB_API_KEY}" }'}
                bind:value={draft.headers}></textarea>
            </label>
          {:else if draft.kind === 'computer_use'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Backend</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                required
                bind:value={draft.backend}
              />
            </label>
            <label class="block space-y-1 text-xs font-medium">
              <span>Endpoint</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                type="url"
                bind:value={draft.endpoint}
              />
            </label>
          {:else if draft.kind === 'image_descriptor'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Harness ID</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                required
                placeholder="opencode"
                bind:value={draft.descriptorHarnessId}
              />
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-xs font-medium">
                <span>Provider ID</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                  required
                  placeholder="anthropic"
                  bind:value={draft.descriptorProviderId}
                />
              </label>
              <label class="space-y-1 text-xs font-medium">
                <span>Model ID (vision)</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                  required
                  placeholder="claude-sonnet-4-5"
                  bind:value={draft.descriptorModelId}
                />
              </label>
            </div>
            <p class="text-[11px] text-dimmed">
              A model from the harness catalog that can see images. Text-only models call this
              utility to describe attached images.
            </p>
          {:else}
            <label class="block space-y-1 text-xs font-medium">
              <span>Provider ID</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                required
                bind:value={draft.providerId}
              />
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-xs font-medium">
                <span>Endpoint</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                  type="url"
                  bind:value={draft.endpoint}
                />
              </label>
              <label class="space-y-1 text-xs font-medium">
                <span>Default model</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                  bind:value={draft.defaultModel}
                />
              </label>
            </div>
          {/if}
        </fieldset>

        {#if !isNative && (draft.kind === 'web_search' || draft.kind === 'web_fetch' || (draft.kind === 'mcp' && (editedUtility?.credentials.length ?? 0) > 0))}
          <fieldset class="space-y-3 rounded-xl border p-3">
            <legend class="px-1 text-xs font-semibold">
              {draft.kind === 'mcp' ? 'MCP secret' : 'API key'}
            </legend>
            {#if draft.id}
              {@const utility = utilities.find((candidate) => candidate.id === draft.id)}
              {#each utility?.credentials ?? [] as credential (credential.id)}
                <div class="flex items-center justify-between rounded-lg bg-elevated px-2 py-1.5">
                  <div class="min-w-0">
                    <p class="truncate text-xs font-medium">{credential.label}</p>
                    <p class="truncate text-[10px] text-dimmed">
                      Stored securely · {credential.environmentVariable ?? credential.id}
                    </p>
                  </div>
                  <button
                    class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                    type="button"
                    aria-label="Remove {credential.label}"
                    title="Remove {credential.label}"
                    onclick={() => void removeCredential(utility?.id ?? '', credential.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              {/each}
            {/if}
            <div class="grid gap-2 sm:grid-cols-2">
              <label class="space-y-1 text-xs font-medium">
                <span>Environment variable</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                  placeholder="API_TOKEN"
                  bind:value={credentialEnvironmentVariable}
                />
              </label>
              <label class="space-y-1 text-xs font-medium">
                <span>Secret value</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                  type="password"
                  autocomplete="off"
                  placeholder={draft.id ? 'Leave blank to keep stored secret' : 'Paste secret'}
                  disabled={!secureStorageAvailable}
                  bind:value={credentialValue}
                />
              </label>
            </div>
            <p class="text-[11px] text-dimmed">
              Saved to encrypted device storage and injected only while this capability is active.
            </p>
          </fieldset>
        {/if}

        <Switch bind:checked={draft.enabled} label="Enabled" class="font-medium" />
      </form>
    {/if}

    {#snippet footer()}
      {#if setupPreset === 'plugin-bundle'}
        <button
          class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          type="button"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="button"
          disabled={saving || !pluginManifest.trim()}
          onclick={() => void importPluginBundle()}
        >
          {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
          Install plugin
        </button>
      {:else}
        <button
          class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          type="button"
          onclick={onClose}
        >
          {draft.id !== null || isNative || setupPreset !== null ? 'Cancel' : 'Close'}
        </button>
        {#if draft.id !== null || isNative}
          <button
            class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            type="button"
            disabled={saving}
            onclick={() => {
              if (isNative && nativeEntry) deleteTarget = { kind: 'native', entry: nativeEntry }
              else if (editingRegistry)
                deleteTarget = { kind: 'registry', utility: editingRegistry }
            }}
          >
            {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
            Delete
          </button>
        {/if}
        {#if draft.id !== null || isNative || setupPreset !== null}
          <button
            class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
            type="submit"
            form="utility-editor-form"
            disabled={saving}
          >
            {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
            {isNative ? 'Save changes' : draft.id ? 'Save utility' : 'Save utility'}
          </button>
        {/if}
      {/if}
    {/snippet}
  </Modal>
{/if}

{#snippet harnessSelector()}
  <fieldset class="space-y-3 rounded-xl border p-3">
    <legend class="px-1 text-xs font-semibold">Available to</legend>
    <p class="text-[11px] text-dimmed">
      Every installed harness is selected by default. CodeInOven skips this capability when a
      harness already provides an equivalent.
    </p>
    {#if availableHarnesses.length}
      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {#each availableHarnesses as harness (harness.id)}
          <button
            type="button"
            class="flex h-10 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors {draft.bindings.some(
              (binding) => binding.harnessId === harness.id
            )
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={draft.bindings.some((binding) => binding.harnessId === harness.id)}
            onclick={() => toggleHarness(harness.id)}
          >
            <AgentIcon agentId={harness.id} label={harness.name} size={16} />
            {harness.name}
          </button>
        {/each}
      </div>
    {:else}
      <div class="rounded-lg bg-raised px-3 py-2">
        <p class="text-xs text-muted">
          No installed, supported harnesses were detected. Open Settings → Harnesses to check
          installations.
        </p>
      </div>
    {/if}
  </fieldset>
{/snippet}

{#if deleteTarget}
  <Modal open title="Delete capability" onClose={() => (deleteTarget = null)}>
    <p class="text-sm text-muted">
      Delete
      <strong class="text-foreground">
        {deleteTarget.kind === 'native' ? deleteTarget.entry.name : deleteTarget.utility?.name}
      </strong>?
      {deleteTarget.kind === 'native'
        ? 'This removes the file on disk. This cannot be undone.'
        : 'Its registry entry and credential references will be removed.'}
    </p>
    {#snippet footer()}
      <button
        class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
        type="button"
        onclick={() => (deleteTarget = null)}
      >
        Cancel
      </button>
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        type="button"
        disabled={saving}
        onclick={() => void deleteUtility()}
      >
        {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
        Delete
      </button>
    {/snippet}
  </Modal>
{/if}
