/// <reference types="vite/client" />

import {
  buildAgentIconEntry,
  normalizeAgentIconId,
  parseAgentIconMetadata,
  type AgentIconEntry,
} from "./agent-registry";

const metadataModules = import.meta.glob("./agents/*/metadata.json", {
  eager: true,
  import: "default",
});

function loadRegistry(): readonly AgentIconEntry[] {
  const entries: AgentIconEntry[] = [];
  for (const rawMetadata of Object.values(metadataModules)) {
    const metadata = parseAgentIconMetadata(rawMetadata);
    if (metadata) entries.push(buildAgentIconEntry(metadata));
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export const agentIconRegistry = loadRegistry();

const registryById = new Map<string, AgentIconEntry>();
for (const entry of agentIconRegistry) {
  registryById.set(entry.id, entry);
  for (const alias of entry.aliases ?? []) registryById.set(alias, entry);
}

export function getAgentIcon(
  agentId: string | undefined,
): AgentIconEntry | undefined {
  return agentId ? registryById.get(normalizeAgentIconId(agentId)) : undefined;
}
