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
  /** When the action was last launched, in epoch milliseconds, so an entry
   *  whose terminal still shows output says how old that run is. Absent until
   *  the action has been run at least once. */
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

export interface ProjectActionInput {
  name: string
  script: string
  variables: ProjectActionVariable[]
  color: string | null
}
