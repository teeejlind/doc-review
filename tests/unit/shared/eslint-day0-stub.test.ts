// tests/unit/shared/eslint-day0-stub.test.ts (integrator, day 0; CONTRACTS §2.4 item 9).
//
// The DAY0-STUB lint rule (eslint.config.js, `mdr/day0-stub`): a well-formed marker passes until its milestone is
// listed as merged, then fails lint; a malformed marker always fails; prose that only mentions the word is ignored.
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const RULE = 'mdr/day0-stub'

async function lint(code: string, merged: string[], filePath = 'core/blocks.ts'): Promise<string[]> {
  const eslint = new ESLint({ overrideConfig: { rules: { [RULE]: ['error', { merged }] } } })
  const [r] = await eslint.lintText(code, { filePath })
  return r!.messages.filter((m) => m.ruleId === RULE).map((m) => m.message)
}

describe('mdr/day0-stub', () => {
  const stub = '// DAY0-STUB (owner: P1; replaced at M1)\nexport const x = 1\n'

  it('passes a well-formed marker whose milestone has not merged', async () => {
    expect(await lint(stub, [])).toEqual([])
    expect(await lint(stub, ['M0'])).toEqual([])
  })

  it('fails once the milestone is merged', async () => {
    const msgs = await lint(stub, ['M1'])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('M1 has merged')
  })

  it('understands the producer-merge milestones', async () => {
    const p2 = '// DAY0-STUB (owner: P2; replaced at P2 merge)\nexport const x = 1\n'
    expect(await lint(p2, ['M1', 'M2'], 'web/src/editor/index.ts')).toEqual([])
    expect(await lint(p2, ['P2 merge'], 'web/src/editor/index.ts')).toHaveLength(1)
  })

  it('fails a malformed marker whatever has merged', async () => {
    expect(await lint('// DAY0-STUB owner P1, M1\nexport const x = 1\n', [])).toHaveLength(1)
    expect(await lint('// DAY0-STUB (owner: P9; replaced at M1)\nexport const x = 1\n', [])).toHaveLength(1)
  })

  it('ignores prose that merely mentions the marker', async () => {
    expect(await lint('// replaced the DAY0-STUB here at M1\n/* DAY0-STUB notes */\nexport const x = 1\n', ['M1'])).toEqual([])
  })
})
