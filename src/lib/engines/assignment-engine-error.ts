export class AssignmentEngineError extends Error {
  constructor(
    readonly code:
      'not_found' | 'immutable' | 'validation_failed' | 'invalid_transition' | 'unauthorized',
    message: string
  ) {
    super(message)
    this.name = 'AssignmentEngineError'
  }
}
