// tests/unit/core/anchors/anchors.test.ts (P1; CONTRACTS §5.2–§5.4, D7, D35, D45; §13 rows 37, 38, 90).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnchor, createBlockAnchor, followBlockAnchor, levenshtein, normalizeForMatch, rawRange, refreshAnchor,
  resolveAnchor, similarity, trimSpan,
} from '../../../../core/anchors'
import { blockChanges } from '../../../../core/diff'
import { createMd, type Md } from '../../../../core/md/index'
import { ptextOf } from '../../../../core/ptext'
import { findQuoteInPtext } from '../../../../core/quote'
import { validateTextAnchor } from '../../../../core/sidecar/validate'
import { load, type Loaded } from '../../../../core/splice/load'
import { CONSTANTS, type Anchor, type TextAnchor } from '../../../../shared/types'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const loadP = (src: string) => {
  const L = load(md, src)
  return { L, p: ptextOf(L.doc, L) }
}
const at = (src: string, quote: string, nth = 0, rev = 1): { L: Loaded; a: TextAnchor } => {
  const { L, p } = loadP(src)
  let from = -1
  for (let k = 0; k <= nth; k++) from = p.text.indexOf(quote, from + 1)
  if (from < 0) throw new Error(`no ${quote}`)
  return { L, a: createAnchor(p, L.blocks, from, from + quote.length, rev) }
}
const resolveIn = (src: string, a: Anchor, o?: { fuzzy?: boolean }) => {
  const { L, p } = loadP(src)
  return { r: resolveAnchor(p, L.blocks, a, o), p, L }
}

describe('createAnchor (§5.2)', () => {
  it('is canonical: identical inputs give byte-identical anchors; the browser and CLI paths agree', () => {
    const src = 'Intro.\n\nThe **member rate** is fixed for the term.\n'
    const { L, p } = loadP(src)
    // browser path: a selection's offsets, trimmed of whitespace
    const sel = trimSpan(p, p.text.indexOf('member') - 1, p.text.indexOf('rate') + 5)
    const browser = createAnchor(p, L.blocks, sel.from, sel.to, 4)
    // CLI path: comment --quote finds the ptext span, the stored anchor is createAnchor over it
    const hit = findQuoteInPtext(md, p, '**member rate**')[0]!
    expect(hit.tier).toBe('markdown')
    const cli = createAnchor(p, L.blocks, hit.from, hit.to, 4)
    expect(JSON.stringify(cli)).toBe(JSON.stringify(browser))
    expect(browser.quote).toBe('member rate')
    expect(Object.keys(browser)).toEqual(['kind', 'quote', 'prefix', 'suffix', 'hint'])
  })

  it('prefix and suffix are up to 32 units and may cross block separators', () => {
    const { a } = at('First block here.\n\nShort.\n', 'Short')
    expect(a.prefix).toBe('First block here.\n')
    expect(a.suffix).toBe('.')
    expect(a.prefix.length).toBeLessThanOrEqual(CONSTANTS.ANCHOR_CONTEXT_CHARS)
  })
})

describe('long anchors (D45)', () => {
  const longDoc = (units: number): string => {
    const words: string[] = []
    let n = 0
    for (let i = 0; n < units; i++) {
      const w = `w${i}`
      words.push(w)
      n += w.length + 1
    }
    return words.join(' ')
  }

  for (const n of [10_001, 60_000]) {
    it(`a ${n}-unit span takes the long form and resolves whole; re-creating it is identical`, () => {
      const body = longDoc(n + 50)
      const { L, p } = loadP(`Start.\n\n${body}\n\nEnd.\n`)
      const from = p.text.indexOf('w0')
      const a = createAnchor(p, L.blocks, from, from + n, 1)
      expect(a.span).toBe(n)
      expect(a.quote).toBe(p.text.slice(from, from + CONSTANTS.LONG_QUOTE_EDGE_CHARS))
      expect(a.tail).toBe(p.text.slice(from + n - CONSTANTS.LONG_QUOTE_EDGE_CHARS, from + n))
      expect(() => validateTextAnchor(a)).not.toThrow()
      const r = resolveAnchor(p, L.blocks, a)
      expect(r).toMatchObject({ state: 'exact', from, to: from + n })
      // the server re-creating it over the resolved span (§5.4) gives the same anchor as the browser did
      expect(createAnchor(p, L.blocks, r.from!, r.to!, 1)).toEqual(a)
    })
  }

  it('an edit inside the span keeps it attached (tail found near head + span)', () => {
    const body = longDoc(12_000)
    const src = `Start.\n\n${body}\n`
    const { L, p } = loadP(src)
    const from = p.text.indexOf('w0')
    const a = createAnchor(p, L.blocks, from, p.text.length, 1)
    const edited = src.replace(' w500 ', ' w500 inserted words here ')
    const { r, p: p2 } = resolveIn(edited, a)
    expect(r.state).toBe('moved')
    expect(r.from).toBe(p2.text.indexOf('w0'))
    expect(r.to).toBe(p2.text.length)
  })

  it('deleting the tail detaches it (the span was cut apart)', () => {
    const body = longDoc(12_000)
    const { L, p } = loadP(`Start.\n\n${body}\n`)
    const from = p.text.indexOf('w0')
    const a = createAnchor(p, L.blocks, from, p.text.length, 1)
    const cut = body.slice(0, body.length - 2_000)
    expect(resolveIn(`Start.\n\n${cut}\n`, a).r).toEqual({ state: 'detached' })
  })

  it('validation rejects a half-long anchor and a short quote with tail/span', () => {
    const { a } = at('Some words here.\n', 'words')
    expect(() => validateTextAnchor({ ...a, tail: 'x'.repeat(CONSTANTS.LONG_QUOTE_EDGE_CHARS) })).toThrow(/anchor/)
    expect(() => validateTextAnchor({ ...a, span: 20_000 })).toThrow(/anchor/)
    expect(() => validateTextAnchor({ ...a, tail: 'abc', span: 20_000 })).toThrow(/anchor/)
  })
})

describe('resolveAnchor: the §5.3 ladder', () => {
  const SRC = 'Intro paragraph.\n\nThe member rate is high this year.\n\nOutro.\n'

  it('1. exact at the hint; 2. moved inside the hinted block; 6. detached', () => {
    const { a } = at(SRC, 'member rate')
    expect(resolveIn(SRC, a).r).toMatchObject({ state: 'exact' })
    const moved = SRC.replace('The member', 'Today the member')
    const { r, p } = resolveIn(moved, a)
    expect(r).toMatchObject({ state: 'moved', from: p.text.indexOf('member rate'), block: 1 })
    expect(resolveIn(SRC.replace('member rate', 'yield'), a).r).toEqual({ state: 'detached' })
  })

  it('3. exact anywhere: one hit is moved; several are scored by context', () => {
    const { a } = at(SRC, 'member rate')
    const elsewhere = 'New first.\n\nAnd the member rate moved here.\n\nOutro.\n'
    expect(resolveIn(elsewhere, a).r.state).toBe('moved')
    const two = 'X: the member rate is high.\n\nY: rate member.\n\nZ: The member rate is low.\n'
    const { r, p } = resolveIn(two, a)
    // "The member rate is high" shares the most prefix/suffix context with the second candidate's... the first wins
    expect(r.from).toBe(p.text.indexOf('member rate'))
    expect(r.ambiguous).toBeUndefined()
  })

  it('3. a full tie takes the first occurrence and is ambiguous, never detached (D7)', () => {
    const src = 'Alpha.\n\nfoo\n\nfoo\n\nOmega.\n'
    const { L, p } = loadP(src)
    const a: TextAnchor = { kind: 'text', quote: 'foo', prefix: '', suffix: '', hint: { rev: 1, pos: Math.round((p.text.indexOf('foo') + p.text.lastIndexOf('foo')) / 2), block: 99, blockHash: '0000000000000000', offsetInBlock: 0 } }
    const r = resolveAnchor(p, L.blocks, a)
    expect(r).toMatchObject({ state: 'moved', from: p.text.indexOf('foo'), ambiguous: true })
  })

  it('4. normalized exact: whitespace runs, NBSP, curly quotes and zero-width characters; offsets map back to raw', () => {
    const { a } = at('Say “hello  world” now.\n', '“hello  world”')
    const plain = 'Say "hello world"​ now.\n'
    const { r, p } = resolveIn(plain, a)
    expect(r.state).toBe('moved')
    expect(p.text.slice(r.from, r.to)).toBe('"hello world"')
    const nbsp = resolveIn('Say “hello world” now.\n', a)
    expect(nbsp.p.text.slice(nbsp.r.from, nbsp.r.to)).toBe('“hello world”')
  })

  it('5. fuzzy only for comments (fuzzy: true): a short quote with a typo, bounded to ±2 blocks', () => {
    const { a } = at(SRC, 'member rate')
    const typo = SRC.replace('member rate', 'memher rate')
    expect(resolveIn(typo, a).r).toEqual({ state: 'detached' })
    const { r, p } = resolveIn(typo, a, { fuzzy: true })
    expect(r.state).toBe('fuzzy')
    expect(p.text.slice(r.from, r.to)).toBe('memher rate')
    // moved more than two blocks away from the hint: out of the fuzzy window
    const far = 'A.\n\nB.\n\nC.\n\nD.\n\nE.\n\nThe memher rate is high this year.\n'
    expect(resolveIn(far, a, { fuzzy: true }).r).toEqual({ state: 'detached' })
  })

  it('5. fuzzy for a long quote: head and tail probes, span within ±25%, similarity >= 0.75', () => {
    const sentence = 'The quarterly report shows steady growth across every product line we track today.'
    const { a } = at(`Intro.\n\n${sentence}\n`, sentence)
    const edited = sentence.replace('steady', 'very steady').replace('every', 'each')
    const { r, p } = resolveIn(`Intro.\n\n${edited}\n`, a, { fuzzy: true })
    expect(r.state).toBe('fuzzy')
    expect(p.text.slice(r.from, r.to)).toBe(edited)
    const rewritten = 'Something else entirely, nothing like the original sentence at all, really.'
    expect(resolveIn(`Intro.\n\n${rewritten}\n`, a, { fuzzy: true }).r.state).toBe('detached')
  })

  it('empty quote (insertion point): the prefix+suffix junction', () => {
    const src = 'Alpha beta gamma.\n'
    const { L, p } = loadP(src)
    const pos = p.text.indexOf(' gamma')
    const a = createAnchor(p, L.blocks, pos, pos, 1)
    expect(a.quote).toBe('')
    expect(resolveAnchor(p, L.blocks, a)).toMatchObject({ state: 'exact', from: pos, to: pos })
    const { r, p: p2 } = resolveIn('Intro.\n\nAlpha beta gamma.\n', a)
    expect(r).toMatchObject({ state: 'moved', from: p2.text.indexOf(' gamma') })
  })

  it('doc anchors resolve to doc', () => {
    expect(resolveIn('x\n', { kind: 'doc' }).r).toEqual({ state: 'doc' })
  })
})

describe('repeated quote in a changed block (QA round 1: confirmed 10)', () => {
  const TABLE = '# Deal status\n\n| Deal | Status |\n|---|---|\n| Deal A | Live |\n| Deal B | Live |\n| Deal C | Live |\n\nClosing note.\n'

  it('a same-shaped row inserted above: the hint lands on the wrong row, context moves the anchor back to Deal C', () => {
    const { a } = at(TABLE, 'Live', 2)
    const next = TABLE.replace('| Deal A | Live |', '| Deal Z | Live |\n| Deal A | Live |')
    const { r, p, L } = resolveIn(next, a)
    expect(r.state).toBe('moved')
    expect(r.from).toBe(p.text.lastIndexOf('Live'))
    expect(r.ambiguous).toBeUndefined()
    // the persisted anchor is the corrected one (refreshAnchor logs a repeated quote whose context differs)
    const fresh = refreshAnchor(p, L.blocks, a, r, 2) as TextAnchor
    expect(fresh.prefix.endsWith('Deal C\n')).toBe(true)
    expect(fresh.hint.pos).toBe(p.text.lastIndexOf('Live'))
  })

  it('a row inserted above a middle row, and one removed above: still the right row', () => {
    const { a } = at(TABLE, 'Live', 1)
    const added = resolveIn(TABLE.replace('| Deal A | Live |', '| Deal Z | Live |\n| Deal A | Live |'), a)
    expect(added.r.from).toBe(added.p.text.indexOf('Deal B\nLive') + 'Deal B\n'.length)
    const removed = resolveIn(TABLE.replace('| Deal A | Live |\n', ''), a)
    expect(removed.r.from).toBe(removed.p.text.indexOf('Deal B\nLive') + 'Deal B\n'.length)
  })

  it('an untouched block still resolves exact at the hint, whatever the context', () => {
    const { a } = at(TABLE, 'Live', 2)
    expect(resolveIn(TABLE.replace('Closing note.', 'Closing note, edited.'), a).r).toMatchObject({ state: 'exact' })
    expect(resolveIn(TABLE, a).r).toMatchObject({ state: 'exact' })
  })
})

describe('block anchors (D35)', () => {
  it('1. by hash (exact, or moved when the index changed)', () => {
    const src = 'a\n\n---\n\nb\n'
    const { L } = loadP(src)
    const b = createBlockAnchor(L.blocks, 1, 1)
    expect(resolveIn(src, b).r).toEqual({ state: 'exact', block: 1 })
    expect(resolveIn('z\n\n' + src, b).r).toEqual({ state: 'moved', block: 2 })
  })

  it('2. the frontmatter singleton follows an edited frontmatter', () => {
    const src = '---\ntitle: a\n---\n\nBody.\n'
    const { L } = loadP(src)
    const b = createBlockAnchor(L.blocks, 0, 1)
    expect(resolveIn(src.replace('title: a', 'title: b\nstatus: draft'), b).r).toEqual({ state: 'moved', block: 0 })
  })

  it('3. preview fallback: same kind and mdType near the hint, similarity >= 0.6', () => {
    const src = 'Intro.\n\n<div class="note">\nRemember the deadline\n</div>\n\nEnd.\n'
    const { L } = loadP(src)
    const raw = L.blocks.findIndex((x) => x.mdType === 'html')
    const b = createBlockAnchor(L.blocks, raw, 1)
    const edited = src.replace('Remember the deadline', 'Remember the deadlines')
    expect(resolveIn(edited, b).r).toEqual({ state: 'fuzzy', block: raw })
    expect(resolveIn(src.replace(/<div[\s\S]*<\/div>/, '<table><tr><td>x</td></tr></table>'), b).r).toEqual({ state: 'detached' })
  })

  it('followBlockAnchor moves an anchor across a 1:1 replace of its block, and only then', () => {
    const src = 'A.\n\n<!-- note one -->\n\nB.\n'
    const before = load(md, src)
    const b = createBlockAnchor(before.blocks, 1, 1)
    const after = load(md, src.replace('note one', 'note two, rewritten entirely'))
    const changes = blockChanges(before, after)
    const moved = followBlockAnchor(b, changes, after.blocks, 2)
    expect(moved).toEqual(createBlockAnchor(after.blocks, 1, 2))
    // a split (1 → 2) falls through to resolution
    const split = load(md, src.replace('<!-- note one -->', '<!-- note -->\n\n<!-- one -->'))
    expect(followBlockAnchor(b, blockChanges(before, split), split.blocks, 2)).toBeNull()
    // an unrelated change never moves it
    const other = load(md, src.replace('B.', 'C.'))
    expect(followBlockAnchor(b, blockChanges(before, other), other.blocks, 2)).toBeNull()
  })
})

describe('detach then reattach (§13 row 38)', () => {
  it('a deleted quote detaches; restoring the text resolves it exact again, unique and unambiguous', () => {
    const src = 'Intro.\n\nThe member rate is fixed.\n\nOutro.\n'
    const { a } = at(src, 'member rate is fixed')
    expect(resolveIn(src.replace('The member rate is fixed.\n\n', ''), a).r).toEqual({ state: 'detached' })
    const back = resolveIn(src, a)
    expect(back.r).toMatchObject({ state: 'exact' })
    expect(back.r.ambiguous).toBeUndefined()
  })
})

describe('refreshAnchor (§5.4 logging rule)', () => {
  it('a unique quote that merely moved is never logged', () => {
    const src = 'Intro.\n\nThe member rate is fixed.\n'
    const { a } = at(src, 'member rate')
    const moved = 'New.\n\nIntro.\n\nThe member rate is fixed.\n'
    const { r, p, L } = resolveIn(moved, a)
    expect(refreshAnchor(p, L.blocks, a, r, 2)).toBeNull()
  })

  it('a duplicated quote whose context drifted is refreshed, and the refreshed anchor keeps the right occurrence', () => {
    // TJ comments on the second occurrence, then edits the context around it (the browser refreshes on save)
    const src = 'The rate is fixed.\n\nMiddle.\n\nAgain the rate is fixed.\n'
    const { a } = at(src, 'rate is fixed', 1)
    const tjEdit = src.replace('Again the rate', 'Once more the rate')
    const { r, p, L } = resolveIn(tjEdit, a)
    expect(r.from).toBe(p.text.lastIndexOf('rate is fixed'))
    const fresh = refreshAnchor(p, L.blocks, a, r, 2) as TextAnchor
    expect(fresh).not.toBeNull()
    expect(fresh.prefix.endsWith('Once more the ')).toBe(true)
    // then Claude writes elsewhere on disk and the page reloads: the server resolves to the second occurrence
    const claude = tjEdit.replace('Middle.', 'Middle, rewritten by Claude.')
    const again = resolveIn(claude, fresh)
    expect(again.r.from).toBe(again.p.text.lastIndexOf('rate is fixed'))
    expect(again.r.ambiguous).toBeUndefined()
    // Claude's edit sits inside the 32-unit prefix window, so the duplicate quote's context is refreshed again,
    // still on the second occurrence
    const re = refreshAnchor(again.p, again.L.blocks, fresh, again.r, 3) as TextAnchor
    expect(re.hint.pos).toBe(again.p.text.lastIndexOf('rate is fixed'))
  })

  it('a duplicated quote whose context and block are untouched logs nothing', () => {
    const src = 'The rate is fixed, says the first and fairly long opening sentence.\n\n' +
      'A middle paragraph that is long enough to keep the windows apart.\n\n' +
      'Again the rate is fixed for the whole quarter and well beyond it.\n\nTail.\n'
    const { a } = at(src, 'rate is fixed', 1)
    const far = resolveIn(src.replace('Tail.', 'Tail, edited by Claude.'), a)
    expect(far.r).toMatchObject({ state: 'exact', from: far.p.text.lastIndexOf('rate is fixed') })
    expect(refreshAnchor(far.p, far.L.blocks, a, far.r, 2)).toBeNull()
    // a block inserted above shifts hint.block, which the duplicate-quote rule does log (D7)
    const above = resolveIn('Inserted first.\n\n' + src, a)
    expect((refreshAnchor(above.p, above.L.blocks, a, above.r, 2) as TextAnchor).hint.block).toBe(a.hint.block + 1)
  })

  it('a fuzzy resolution is always re-created over the resolved span', () => {
    const src = 'Intro.\n\nThe member rate is high.\n'
    const { a } = at(src, 'member rate')
    const { r, p, L } = resolveIn(src.replace('member', 'memher'), a, { fuzzy: true })
    expect(r.state).toBe('fuzzy')
    expect((refreshAnchor(p, L.blocks, a, r, 2) as TextAnchor).quote).toBe('memher rate')
  })
})

describe('helpers', () => {
  it('normalizeForMatch maps every normalized unit back to its raw range', () => {
    const raw = 'a   “b”​\tc'
    const N = normalizeForMatch(raw)
    expect(N.text).toBe('a "b" c')
    expect(rawRange(N, 2, 5)).toEqual({ from: 4, to: 7 })
    expect(raw.slice(rawRange(N, 1, 2).from, rawRange(N, 1, 2).to)).toBe('   ')
  })

  it('levenshtein and similarity, short and long', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(similarity('', '')).toBe(1)
    const long = 'x'.repeat(2000)
    expect(levenshtein(long, long.slice(0, 1990) + 'y'.repeat(10))).toBe(10)
  })
})

describe('partial survival (QA round 1: confirmed 8, 9)', () => {
  const SENTENCE = 'The Northwind Community Garden Fund targets senior, first-lien facilities to small specialty lenders.'
  const PARA = `${SENTENCE} Distributions are intended monthly after a two-year lock. Redemptions follow the schedule in the offering documents.`
  const text = (src: string, r: { from?: number; to?: number }, p: { text: string }): string => p.text.slice(r.from!, r.to!)

  it('the last word of the commented sentence changed: the comment follows what is left', () => {
    const { a } = at(PARA, SENTENCE)
    const next = PARA.replace('small specialty lenders.', 'small specialty originators.')
    const { r, p } = resolveIn(next, a, { fuzzy: true })
    expect(r.state).toBe('fuzzy')
    expect(text(next, r, p)).toBe(SENTENCE.replace('lenders.', 'originators.'))
  })

  it('the first words changed', () => {
    const { a } = at(PARA, SENTENCE)
    const next = PARA.replace('The Northwind Community Garden Fund', 'The NCGF')
    const { r, p } = resolveIn(next, a, { fuzzy: true })
    expect(r.state).toBe('fuzzy')
    expect(text(next, r, p)).toBe(SENTENCE.replace('The Northwind Community Garden Fund', 'The NCGF'))
  })

  it('a short sentence with its tail replaced (accepting Claude\'s suggestion)', () => {
    const base = 'Distributions are intended monthly after a two-year lock.'
    const { a } = at(`Intro.\n\n${base}\n\nOutro.\n`, base)
    const next = `Intro.\n\nDistributions are intended monthly after a 24-month lock.\n\nOutro.\n`
    const { r, p } = resolveIn(next, a, { fuzzy: true })
    expect(r.state).not.toBe('detached')
    expect(text(next, r, p)).toBe('Distributions are intended monthly after a 24-month lock.')
  })

  it('half of the quote deleted: still attached, snapped to whole words', () => {
    const { a } = at(PARA, SENTENCE)
    const next = PARA.replace(' first-lien facilities to small specialty lenders.', '.')
    const { r, p } = resolveIn(next, a, { fuzzy: true })
    expect(r.state).not.toBe('detached')
    const got = text(next, r, p)
    expect(got.startsWith('The Northwind Community Garden Fund')).toBe(true)
    expect(got).toBe(got.trim())
  })

  it('genuinely deleted text still detaches', () => {
    const { a } = at(PARA, SENTENCE)
    const next = PARA.replace(`${SENTENCE} `, '')
    const { r } = resolveIn(next, a, { fuzzy: true })
    expect(r.state).toBe('detached')
  })

  it('no fuzzy for suggestion threads (fuzzy off): unchanged', () => {
    const { a } = at(PARA, SENTENCE)
    const next = PARA.replace('small specialty lenders.', 'small specialty originators.')
    expect(resolveIn(next, a).r.state).toBe('detached')
  })
})
