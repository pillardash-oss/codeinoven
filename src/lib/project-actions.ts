export interface ProjectActionVariable {
  name: string
  label: string
  required: boolean
}

export interface ProjectAction {
  id: string
  name: string
  script: string
  variables: ProjectActionVariable[]
  /** Optional label colour (hex) shown as the entry's left border. */
  color?: string | null
  createdAt: number
  updatedAt: number
}

export interface ProjectActionInput {
  name: string
  script: string
  variables: ProjectActionVariable[]
  color: string | null
}
