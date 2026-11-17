// web/src/useIdentity.ts (Pass 4 #13). The shell's hook for the human's display name: it keeps asking the server whether
// the name changed (`mdr config set name` while the page is open) and re-renders its caller when it did, so every card,
// reply and copied prompt that reads the name from the tags shows the new one without a reload.
import { useEffect, useSyncExternalStore } from 'react'
import type { DocSession } from '../../shared/types'
import { identityVersion, subscribeIdentity, watchIdentity } from './identity'

export function useIdentityWatch(session: DocSession): void {
  useSyncExternalStore(subscribeIdentity, identityVersion, identityVersion)
  useEffect(() => watchIdentity(session), [session])
}
