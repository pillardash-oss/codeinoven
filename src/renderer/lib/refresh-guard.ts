/** Rejects results from asynchronous requests superseded by a newer request. */
export class LatestRequestGuard {
  private latestRequest = 0

  begin(): number {
    this.latestRequest += 1
    return this.latestRequest
  }

  isCurrent(request: number): boolean {
    return request === this.latestRequest
  }
}
