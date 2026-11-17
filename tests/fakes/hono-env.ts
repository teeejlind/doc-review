// tests/fakes/hono-env.ts (integrator, day 0). The Hono context variables fakeApp's security middleware sets (§8.1) and
// the routes it mounts (its own and the handoff stub's) read.
import type { ClientId } from '../../shared/types'

export interface FakeVars {
  /** Actor by path prefix (§8.1 step 2): /api/agent/* = Claude, other /api/* = TJ, else null. */
  actor: 'TJ' | 'Claude' | null
  /** The validated `file` (?file= or the agent body's "file"); null when the route takes none. */
  file: string | null
  /** The parsed JSON body (non-GET); undefined for GET. */
  body: unknown
  /** X-MDR-Client-Id (browser non-GET, or ?clientId= on /api/events). */
  clientId: ClientId | undefined
}

export type FakeEnv = { Variables: FakeVars }
