import type { EngineeringSpec } from '$shared/types'

export function statusLabel(status: EngineeringSpec['status']): string {
  return status.replace('_', ' ')
}

export function statusClass(status: EngineeringSpec['status']): string {
  if (status === 'approved') return 'bg-success/10 text-success'
  if (status === 'in_review') return 'bg-info/10 text-info'
  if (status === 'superseded') return 'bg-raised text-dimmed'
  return 'bg-warning/10 text-warning'
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(timestamp)
}
