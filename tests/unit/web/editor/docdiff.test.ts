// tests/unit/web/editor/docdiff.test.ts (QA3 R1, server-store). docDiffSteps turns one doc into another touching only
// what differs, so position-based decorations (comment highlights) survive a draft restore the way they survive typing.
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { load } from '../../../../core/splice/load'
import { docDiffSteps } from '../../../../web/src/editor/docdiff'
import { sharedMd } from '../../../fakes/FakeDocStore'

const docOf = async (markdown: string): Promise<PMNode> => load(await sharedMd(), markdown).doc

/** Position of `text` in the first text node that contains `within` (default: `text` itself). */
function posOf(doc: PMNode, text: string, within = text): number {
  let at = -1
  doc.descendants((n, p) => {
    if (at < 0 && n.isText && n.text!.includes(within)) at = p + n.text!.indexOf(within) + within.indexOf(text)
    return at < 0
  })
  if (at < 0) throw new Error(`no ${text}`)
  return at
}

const BASE = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n\n- one\n- two\n- three\n'

describe('docDiffSteps', () => {
  it('equal docs need no step', async () => {
    const a = await docOf(BASE)
    const tr = docDiffSteps(a, await docOf(BASE))
    expect(tr?.steps).toEqual([])
  })

  it('typing in one paragraph is one inline step; other positions map as typing would map them', async () => {
    const a = await docOf(BASE)
    const b = await docOf(BASE.replace('Second paragraph', 'Second big paragraph'))
    const tr = docDiffSteps(a, b)!
    expect(tr.doc.eq(b)).toBe(true)
    expect(tr.steps).toHaveLength(1)
    const first = posOf(a, 'First')
    const third = posOf(a, 'Third')
    expect(tr.mapping.map(first)).toBe(first)
    expect(tr.mapping.map(third)).toBe(third + 'big '.length)
    // a position inside the typed-into paragraph, before and after the typed text
    const before = posOf(a, 'Second') + 2
    const after = posOf(a, 'here', 'Second paragraph here.')
    expect(tr.mapping.map(before)).toBe(before)
    expect(tr.mapping.map(after)).toBe(after + 'big '.length)
  })

  it('edits in two separate paragraphs leave the block between them where it was', async () => {
    const a = await docOf(BASE)
    const b = await docOf(BASE.replace('First', 'Opening').replace('Third', 'Closing'))
    const tr = docDiffSteps(a, b)!
    expect(tr.doc.eq(b)).toBe(true)
    const mid = posOf(a, 'Second')
    expect(tr.mapping.map(mid)).toBe(mid + ('Opening'.length - 'First'.length))
    // a position inside the untouched middle block maps by shift only: it never collapses
    expect(tr.mapping.map(mid + 3, 1)).toBe(mid + 3 + ('Opening'.length - 'First'.length))
  })

  it('a deleted span collapses, the text around it survives', async () => {
    const a = await docOf(BASE)
    const b = await docOf(BASE.replace('Second paragraph here.', 'Second here.'))
    const tr = docDiffSteps(a, b)!
    expect(tr.doc.eq(b)).toBe(true)
    const gone = posOf(a, 'paragraph', 'Second paragraph here.')
    const kept = posOf(a, 'here', 'Second paragraph here.')
    expect(tr.mapping.mapResult(gone + 3).deleted).toBe(true)
    expect(tr.mapping.mapResult(kept).deleted).toBe(false)
  })

  it('an added and a removed paragraph change the child count; the untouched ones keep their positions', async () => {
    const a = await docOf(BASE)
    const added = await docOf(BASE.replace('Third paragraph here.', 'Inserted here.\n\nThird paragraph here.'))
    const t1 = docDiffSteps(a, added)!
    expect(t1.doc.eq(added)).toBe(true)
    expect(t1.mapping.map(posOf(a, 'First'))).toBe(posOf(a, 'First'))
    const removed = await docOf(BASE.replace('Second paragraph here.\n\n', ''))
    const t2 = docDiffSteps(a, removed)!
    expect(t2.doc.eq(removed)).toBe(true)
    expect(t2.mapping.map(posOf(a, 'First'))).toBe(posOf(a, 'First'))
    expect(t2.mapping.mapResult(posOf(a, 'Second') + 2).deleted).toBe(true)
  })

  it('a paragraph split inside one block leaves the others alone', async () => {
    const a = await docOf(BASE)
    const b = await docOf(BASE.replace('Second paragraph here.', 'Second\n\nparagraph here.'))
    const tr = docDiffSteps(a, b)!
    expect(tr.doc.eq(b)).toBe(true)
    expect(tr.mapping.map(posOf(a, 'First'))).toBe(posOf(a, 'First'))
  })

  it('recurses into containers: an edit inside one list item keeps the other items', async () => {
    const a = await docOf(BASE)
    const b = await docOf(BASE.replace('- two', '- two and a half'))
    const tr = docDiffSteps(a, b)!
    expect(tr.doc.eq(b)).toBe(true)
    expect(tr.steps).toHaveLength(1)
    const one = posOf(a, 'one')
    expect(tr.mapping.map(one)).toBe(one)
    const three = posOf(a, 'three')
    expect(tr.mapping.map(three)).toBe(three + ' and a half'.length)
  })

  it('docs of a different markup at the root, or no common structure, still end up equal (whole replace)', async () => {
    const a = await docOf(BASE)
    const b = await docOf('Just one paragraph now.\n')
    const tr = docDiffSteps(a, b)!
    expect(tr.doc.eq(b)).toBe(true)
  })
})
