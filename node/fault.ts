// node/fault.ts (P1). MDR_FAULT writer crash points (CONTRACTS §13 rows 3-7, Appendix A, tests/helpers/faults.ts).
//
// MDR_FAULT=after-object|after-wal|after-tmp|after-rename makes the writer process.exit(137) at that point of the
// commit; MDR_FAULT=mid-append:<n> makes the sidecar append write only the first <n> bytes of its batch and then exit
// (a torn tail). Production never sets the variable.
//
// In-process unit tests can't let the writer exit, so `setFaultHandlerForTests` replaces process.exit with a handler.
// A handler that throws plays a dead process (the store instance is abandoned, and a fresh store plays the next lock
// holder); one that returns lets the commit go on, which is how a test lands an external write inside the commit
// window (row 12). A mid-append fault always stops the write: the handler must throw (or it is thrown for it).
export type FaultPoint = 'after-object' | 'after-wal' | 'after-tmp' | 'after-rename'

/** What a fault-injected writer exits with. */
export const FAULT_EXIT = 137

let handler: ((point: string) => void) | null = null

/** Test-only: replace the process exit with `h` (null restores it). */
export function setFaultHandlerForTests(h: ((point: string) => void) | null): void {
  handler = h
}

/** Crash here when MDR_FAULT names this point (or call the test handler). */
export function fault(point: FaultPoint): void {
  if (process.env.MDR_FAULT !== point) return
  if (handler) {
    handler(point)
    return
  }
  process.exit(FAULT_EXIT)
}

/** The byte count of an active `mid-append:<n>` fault, or null. */
export function midAppendBytes(): number | null {
  const m = /^mid-append:(\d+)$/.exec(process.env.MDR_FAULT ?? '')
  return m ? Number(m[1]) : null
}

/** Crash after a partial append (the caller already wrote the first `n` bytes). */
export function crashMidAppend(): never {
  const point = process.env.MDR_FAULT ?? 'mid-append'
  if (handler) {
    handler(point)
    throw new Error(`fault ${point}: the append stopped part-way`)
  }
  process.exit(FAULT_EXIT)
}
