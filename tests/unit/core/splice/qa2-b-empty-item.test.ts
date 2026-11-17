// tests/unit/core/splice/qa2-b-empty-item.test.ts (QA fix pass 2, agent B: CONFIRMED 30). An empty list item or quote
// line serialises without Milkdown's `<br />` placeholder, and both spellings load as the same editable list.
import { describe, expect, it } from 'vitest'
import { load } from '../../../../core/splice/load'
import { md } from '../suggest/helpers'

const kinds = async (src: string): Promise<string[]> => load(await md(), src).entries.map((e) => `${e.kind}/${e.fidelity}`)

describe('empty list items (QA2 30)', () => {
  it('a bare "-" or "1." item loads as an editable list, exact (it used to fall back to a raw block)', async () => {
    expect(await kinds('- a\n-\n')).toEqual(['md/exact'])
    expect(await kinds('1. a\n2.\n')).toEqual(['md/exact'])
  })

  it('the "<br />" spelling an earlier build wrote still loads as an editable list and keeps its bytes until touched', async () => {
    const m = await md()
    const L = load(m, '- a\n- <br />\n- c\n')
    expect(L.entries.map((e) => e.kind)).toEqual(['md'])
    expect(L.src).toBe('- a\n- <br />\n- c\n')
    expect(L.entries[0]!.nodes[0]!.toString()).toBe('bullet_list(list_item(paragraph("a")), list_item(paragraph), list_item(paragraph("c")))')
  })

  it('an empty item serialises as the bare marker', async () => {
    const m = await md()
    const doc = load(m, '- a\n- <br />\n- c\n').doc
    expect(m.serializeNodes([...doc.children])).toBe('- a\n-\n- c\n')
    const ord = load(m, '1. a\n2.\n').doc
    expect(m.serializeNodes([...ord.children])).toBe('1. a\n2.\n')
  })
})
