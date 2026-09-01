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
  createdAt: number
  updatedAt: number
}

export interface ProjectActionInput {
  name: string
  script: string
  variables: ProjectActionVariable[]
}
