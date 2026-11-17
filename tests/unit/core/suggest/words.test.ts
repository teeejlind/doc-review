// tests/unit/core/suggest/words.test.ts (QA round 1: word-level suggestion diffs).
//
// Suggestions are diffed on word boundaries, never mid-word, so the track change in the doc, the card's "Replace x → y"
// line and `mdr pending` all show whole words ("12%" → "11.5%", "Our" → "Every"), and whitespace-only hunks never
// reach the card when something else changed.
import { describe, expect, it } from 'vitest'
import { hunksOf } from '../../../../core/suggest/record'
import { phraseSpan, wordSpans } from '../../../../core/suggest/words'
import { md } from './helpers'

/** [del, ins] per span, read back off the two strings. */
function pairs(a: string, b: string): Array<[string, string]> {
  return wordSpans(a, b).map((s) => [a.slice(s.a0, s.a1), b.slice(s.b0, s.b1)])
}

describe('wordSpans', () => {
  it('no change → no spans', () => {
    expect(wordSpans('same words', 'same words')).toEqual([])
  })

  it('numbers and percents are one token', () => {
    expect(pairs('The rate is 12% today.', 'The rate is 11.5% today.')).toEqual([['12%', '11.5%']])
    expect(pairs('The minimum is $500 and', 'The minimum is $1,000 and')).toEqual([['$500', '$1,000']])
    expect(pairs('a fee of 1.5% applies', 'a fee of 1.25% applies')).toEqual([['1.5%', '1.25%']])
  })

  it('a swapped word is the whole word, not the letters that differ', () => {
    expect(pairs('pay returns monthly.', 'pay returns weekly.')).toEqual([['monthly', 'weekly']])
    expect(pairs('Rising rates', 'Increasing rates')).toEqual([['Rising', 'Increasing']])
    expect(pairs('Our platform', 'Over platform')).toEqual([['Our', 'Over']])
  })

  it('contractions and hyphenated words stay whole', () => {
    expect(pairs("It shouldn't change", 'It should not change')).toEqual([["shouldn't", 'should not']])
    expect(pairs('a short duration note', 'a short-duration note')).toEqual([['short duration', 'short-duration']])
  })

  it('insert-only and delete-only changes are whole words', () => {
    expect(pairs('the explainer page', 'the lead-gen explainer page')).toEqual([['', 'lead-gen ']])
    expect(pairs('the old explainer page', 'the explainer page')).toEqual([['old ', '']])
  })

  it('a phrase swap is one span; separate words stay separate', () => {
    expect(pairs('Ship the explainer page', 'Launch the lead-gen explainer microsite')).toEqual([
      ['Ship', 'Launch'],
      ['', 'lead-gen '],
      ['page', 'microsite'],
    ])
    expect(pairs('We launch in Q3.', 'We launch on September 30.')).toEqual([['in Q3', 'on September 30']])
    expect(pairs('small specialty lenders.', 'small specialty originators (e.g. invoice factors).')).toEqual([['lenders', 'originators (e.g. invoice factors)']])
  })

  it('applying every span to the base gives the proposed text', () => {
    const cases: Array<[string, string]> = [
      ['Our originators are vetted.', 'Every originator is vetted.'],
      ['Grow the waitlist now', 'Grow the mailing list now'],
      ['a  b   c', 'a b c'],
      ['', 'new text'],
      ['gone entirely', ''],
      ['emoji 😀 stays whole', 'emoji 😃 stays whole'],
    ]
    for (const [a, b] of cases) {
      let out = ''
      let at = 0
      for (const s of wordSpans(a, b)) {
        out += a.slice(at, s.a0) + b.slice(s.b0, s.b1)
        at = s.a1
      }
      out += a.slice(at)
      expect(out).toBe(b)
    }
  })

  it('never splits a surrogate pair', () => {
    for (const s of wordSpans('x 😀 y', 'x 😃 y')) {
      const bad = (str: string, i: number): boolean => i > 0 && i < str.length && str.charCodeAt(i - 1) >= 0xd800 && str.charCodeAt(i - 1) <= 0xdbff && str.charCodeAt(i) >= 0xdc00 && str.charCodeAt(i) <= 0xdfff
      expect(bad('x 😀 y', s.a0) || bad('x 😀 y', s.a1) || bad('x 😃 y', s.b0) || bad('x 😃 y', s.b1)).toBe(false)
    }
  })

  it('unit keys: equal text with different keys is a change, at the word', () => {
    const a = 'plain bold words'
    const ka = [...a].map((c, i) => (i >= 6 && i < 10 ? `${c}|b` : `${c}|`))
    const kb = [...a].map((c) => `${c}|`)
    const spans = wordSpans(a, a, ka, kb)
    expect(spans.map((s) => a.slice(s.a0, s.a1))).toEqual(['bold'])
  })
})

describe('hunksOf is word-level', () => {
  const run = async (base: string, proposed: string) => hunksOf(await md(), { base, proposed }, 0).map((h): [string, string] => [h.del, h.ins])

  it('12% → 11.5% is one hunk on the whole figure', async () => {
    expect(await run('The member is 12% monthly.', 'The member is 11.5% monthly.')).toEqual([['12%', '11.5%']])
  })

  it('waitlist → mailing list, Our → Every', async () => {
    expect(await run('Grow the waitlist.', 'Grow the mailing list.')).toEqual([['waitlist', 'mailing list']])
    expect(await run('Our originators are vetted.', 'Every originator is vetted.')).toEqual([['Our originators are', 'Every originator is']])
  })

  it('a whitespace-only hunk is dropped when a real one is present', async () => {
    const hs = await run('slice of  asset-based loans.', 'slice of asset-backed loans.')
    expect(hs.every(([d, i]) => d.trim() !== '' || i.trim() !== '')).toBe(true)
    expect(hs).toEqual([['asset-based', 'asset-backed']])
  })

  it('records the offset of each hunk in the base text', async () => {
    const m = await md()
    const hs = hunksOf(m, { base: 'one two three', proposed: 'one 2 three' }, 10)
    expect(hs).toEqual([{ del: 'two', ins: '2', at: 14 }])
  })
})

describe('phraseSpan (what the card quotes)', () => {
  const text = 'The notes carry a member rate of 12% paid monthly. We launch in Q3.'
  const q = (hunks: Array<{ del: string; at: number }>): string | null => {
    const s = phraseSpan(hunks, text)
    return s ? text.slice(s.from, s.to) : null
  }

  it('one hunk: its words', () => {
    expect(q([{ del: '12%', at: text.indexOf('12%') }])).toBe('12%')
  })

  it('several hunks: from the first change to the end of the last, so the card shows the whole phrase', () => {
    expect(q([{ del: 'member', at: text.indexOf('member') }, { del: 'monthly', at: text.indexOf('monthly') }])).toBe('member rate of 12% paid monthly')
  })

  it('a pure insertion quotes the word before it', () => {
    expect(q([{ del: '', at: text.indexOf(' paid') }])).toBe('12%')
    expect(q([{ del: '', at: text.indexOf('. We') }])).toBe('monthly')
  })

  it('an insertion at the very start quotes the word after it; no hunks, no span', () => {
    expect(q([{ del: '', at: 0 }])).toBe('The')
    expect(phraseSpan([], text)).toBeNull()
  })
})

describe('phraseSpan: an insertion at the end of a block (QA3)', () => {
  it('takes the last word of that block, never the first word of the next one', () => {
    const text = 'First paragraph text.\nSecond paragraph.'
    const at = 'First paragraph text.'.length
    expect(phraseSpan([{ del: '', at }], text)).toEqual({ from: 16, to: 20 })
  })
  it('at the start of a block it still takes the word after, inside that block', () => {
    const text = 'One.\nTwo words.'
    expect(phraseSpan([{ del: '', at: 5 }], text)).toEqual({ from: 5, to: 8 })
  })
})
