/** Names and locations accepted for a project's lightweight design contract. */
export const DESIGN_CONTRACT_DIRECTORIES = ['', 'apps', 'src'] as const
export function isDesignContractName(name: string): boolean {
  return /^designs?\.md$/iu.test(name)
}

export function designContractRequest(directory: string): string {
  return `@cio-design Generate a lightweight DESIGN.md for this project using the design in ${JSON.stringify(directory)}. Read existing DESIGN.md or DESIGNS.md case-insensitively at the project root, apps and src, root first. Reuse project CSS tokens and components.json conventions where present. Describe the actual palette, typography, spacing, reusable components, interaction states and accessibility decisions, without a catalogue. Use the design capability's write-contract operation to preserve every existing matching contract as a timestamped backup and write the new root DESIGN.md. Report the new path and all backup paths. Do not rewrite the design itself.`
}
