import { describe, expect, it } from 'vitest'
import { LOCAL_OVEN_ID, type Oven } from '../../../src/lib/ovens'
import { remoteOvensForSetup } from '../../../src/lib/oven-setup-policy'

describe('oven setup selection contract', () => {
  it('never offers Local for full setup', () => {
    const entries: Oven[] = [
      { id: LOCAL_OVEN_ID, kind: 'local', name: 'Local', icon: 'desktop', color: '#000', hasPrivateKey: false, hasPassphrase: false, hasPublicKey: false, createdAt: 1, updatedAt: 1 },
      { id: 'remote-1', kind: 'ssh', name: 'Build host', icon: 'server', color: '#000', hasPrivateKey: false, hasPassphrase: false, hasPublicKey: false, createdAt: 1, updatedAt: 1 }
    ]
    expect(remoteOvensForSetup(entries).map((oven) => oven.id)).toEqual(['remote-1'])
  })
})
