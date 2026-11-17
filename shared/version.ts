// doc-review v2 (mdr): version identity. Owner: integrator. MDR_VERSION must equal package.json "version"
// (asserted by tests/contract/examples.test.ts). It feeds Health.version, ServerMarker.version, the sidecar
// header's createdBy, and core/md/fingerprint.ts (schemaFingerprint = sha256(schema spec + CORE_VERSION)).
export const MDR_VERSION = '2.0.0-dev' as const
/** Bumped only when core/md's schema or splice output changes; part of schemaFingerprint. */
export const CORE_VERSION = 'core/1' as const
export const CREATED_BY = `mdr/${MDR_VERSION}` as const
