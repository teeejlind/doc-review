// tests/e2e/t3-active-card-alignment.spec.ts (T3; TJ's ruling of 2026-10-25 on QA pass 4 #25; CONTRACTS §11.1 I1, §11.4).
//
// Idle cards may drift above or below their text. The ACTIVE card may not: it sits level with the line it belongs to.
// The layout engine says so (top_active = max(anchorY, minTop)); these specs prove it in a real browser, with the real
// server, the real editor and a real Claude editing the document, by measuring the active card's top against its
// highlight's top in the window (both move with the scroll, so what is measured is what TJ sees, once a scroll settles).
//
// The legitimate exception is an anchor above the rail header's bottom edge (minTop): its card waits under the
// header, so the expected top is max(anchorTop, headerBottom).
//
// Not asserted here, on purpose: a crowded line right under the header, where the cards above the active one cannot fit
// between the header and the line even folded to one line each (four comments on one line of a document's first
// paragraph, or two or three with the rail's settings panel open). The scheduler then gives the pin up instead of hiding
// comments behind a "+N above" chip (QA3 rail-ui 3 / 11), and tests/unit/web/rail/scheduler.test.ts and
// qa3-r1-rail-ui.spec.ts hold that. Every case below keeps the cards above the active one able to fit.
import type { Locator, Page } from '@playwright/test'
import { claude, openDoc, type ServerLike } from './fixtures/p2'
import { openRailSettings, railDoc, railSettled, railState, sel } from './fixtures/p3'
import { expect, test } from './fixtures'
import type { TmpRoot } from '../helpers/tmpRoot'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const SIZES = [
  [1440, 900],
  [1280, 800],
] as const

const FILE = 'cluster.md'
/** A body that wraps across five or six lines of the rail, so its card is tall when it opens. */
const LONG_BODY = 'This note runs long on purpose, so that its card takes many lines in the rail once it is open and the cards under it have to make room. '.repeat(4)
const SHORT_BODY = 'Is this still right?'
/** Five or six lines in the rail's narrowest width: a tall card that still fits the window with the dock under it. */
const MEDIUM_BODY = 'This note takes a handful of lines in the rail once it is open. It stops well short of the window.'

// ---- the document -------------------------------------------------------------------------------------------------

/** Seven anchors on consecutive lines and sentences: single-line paragraphs, then three sentences of one paragraph. */
const CLUSTER = ['kq0x', 'kq1x', 'kq2x', 'kq3x', 'kq4x', 'kq5x', 'kq6x'] as const
const BODIES = [LONG_BODY, SHORT_BODY, LONG_BODY, SHORT_BODY, LONG_BODY, SHORT_BODY, LONG_BODY]

function clusterBlock(): string[] {
  return [
    `Alpha line stays short and carries ${CLUSTER[0]}.`,
    `Beta line stays short and carries ${CLUSTER[1]}.`,
    `Gamma sentence carries ${CLUSTER[2]}. Delta sentence carries ${CLUSTER[3]}. Epsilon sentence carries ${CLUSTER[4]} and runs on a while longer so that this paragraph wraps onto a second line at the reading measure.`,
    `Zeta line stays short and carries ${CLUSTER[5]}.`,
    `Eta line stays short and carries ${CLUSTER[6]}.`,
  ]
}

/** The same seven anchors as seven sentences of ONE paragraph, a line or so apart. */
function proseBlock(): string[] {
  return [CLUSTER.map((q, i) => `Sentence number ${i} carries ${q} and fills out its line with a few more words to wrap.`).join(' ')]
}

/** `lead` filler paragraphs, the cluster, then 14 more paragraphs of room below it. */
function clusterDoc(lead: number, block: () => string[] = clusterBlock): string {
  const filler = railDoc(lead + 14)
    .split('\n\n')
    .filter(Boolean)
  // railDoc: title + opening + (section heading + paragraph)...; keep the first `lead` lines, put the cluster after them
  const head = filler.slice(0, 2 + lead)
  const tail = filler.slice(2 + lead)
  return [...head, ...block(), ...tail].join('\n\n') + '\n'
}

async function seed(server: ServerLike, file: string, quotes: readonly string[], bodies: readonly string[]): Promise<string[]> {
  const made = await claude(server, file, quotes.map((quote, i) => ({ op: 'comment' as const, quote, body: bodies[i % bodies.length]! })))
  return made.results.map((r) => r.thread!)
}

// ---- measuring ----------------------------------------------------------------------------------------------------

interface Level {
  cardTop: number
  cardBottom: number
  hlTop: number
  /** Bottom of the rail header panel in the window: where a card can start at the earliest. */
  headerBottom: number
  /** max(highlight top, header bottom): where the active card has to be. */
  expected: number
  active: string | undefined
  placed: string | undefined
  collapsed: string | undefined
  scrollTop: number
}

/** The card's and its highlight's tops, in the window (a scroll moves both, so a settled scroll cannot matter). */
const level = (page: Page, thread: string): Promise<Level> =>
  page.evaluate(
    ([cardSel, hlSel, headerSel]) => {
      const card = document.querySelector<HTMLElement>(cardSel!)!
      const hl = document.querySelector<HTMLElement>(hlSel!)!
      const header = document.querySelector<HTMLElement>(headerSel!)!
      const r = card.getBoundingClientRect()
      const hlTop = hl.getBoundingClientRect().top
      const headerBottom = header.getBoundingClientRect().bottom
      return {
        cardTop: r.top,
        cardBottom: r.bottom,
        hlTop,
        headerBottom,
        expected: Math.max(hlTop, headerBottom),
        active: card.dataset.active,
        placed: card.dataset.placed,
        collapsed: card.dataset.collapsed,
        scrollTop: document.getElementById('mdr-scroll')!.scrollTop,
      }
    },
    [sel('card', { 'data-thread': thread }), sel('highlight', { 'data-thread': thread }), sel('railHeader')] as const,
  )

/** The active card is open, placed, the only active one, and level with its line (within 2px). */
async function expectLevel(page: Page, thread: string, label: string): Promise<Level> {
  await railSettled(page, 350)
  const m = await level(page, thread)
  const where = `${label}: card top ${m.cardTop.toFixed(1)}, line ${m.hlTop.toFixed(1)}, header bottom ${m.headerBottom.toFixed(1)}`
  expect(m.active, `${where}: active`).toBe('true')
  expect(m.placed, `${where}: placed`).toBe('true')
  expect(m.collapsed, `${where}: open`).toBe('false')
  expect(await page.locator(sel('card') + '[data-active="true"]').count(), `${where}: one active card`).toBe(1)
  expect(Math.abs(m.cardTop - m.expected), where).toBeLessThanOrEqual(2)
  return m
}

/** The scenario is the one the ruling is about: with a card active, the idle cards around it are not all level with their text. */
async function expectOthersDrift(page: Page): Promise<void> {
  const st = await railState(page)
  const drifted = st.cards.filter((c) => !c.active && c.anchor !== null && Math.abs(c.top - c.anchor) > 24)
  expect(drifted.length, 'some idle card is more than 24px off its text, or the cluster is not tight enough to prove anything').toBeGreaterThan(0)
}

const scrollTo = (page: Page, to: number | 'end'): Promise<void> =>
  page.evaluate((y) => {
    const sc = document.getElementById('mdr-scroll')!
    sc.scrollTop = y === 'end' ? sc.scrollHeight : y
  }, to)

/** Scroll so the line holding `text` sits `y` px below the top of the scroll box. */
async function scrollTextTo(page: Page, text: string, y: number): Promise<void> {
  await page.evaluate(
    ([t, at]) => {
      const sc = document.getElementById('mdr-scroll')!
      const walker = document.createTreeWalker(document.querySelector('#mdr-editor-host .ProseMirror')!, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const i = n.data.indexOf(t as string)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + (t as string).length)
        sc.scrollTop += r.getBoundingClientRect().top - sc.getBoundingClientRect().top - (at as number)
        return
      }
      throw new Error(`no text ${t}`)
    },
    [text, y] as const,
  )
  await railSettled(page, 50)
}

const highlight = (page: Page, thread: string): Locator => page.locator(sel('highlight', { 'data-thread': thread })).first()
const card = (page: Page, thread: string): Locator => page.locator(sel('card', { 'data-thread': thread }))
/** The card's head: plain card body, not a control, so a click there is a card-body activation (§11.4). */
const cardHead = (page: Page, thread: string): Locator => card(page, thread).locator('.mdr-card-label')
const dock = (page: Page): Locator => page.locator(sel('docComposer'))
const dockInput = (page: Page): Locator => page.locator(sel('docComposerInput'))

// ---- (a) and (b): a tight cluster, activated from the text and from the card ---------------------------------------

const SHAPES = [
  ['single-line paragraphs and a three-sentence one', clusterBlock],
  ['seven sentences of one paragraph', proseBlock],
] as const

for (const [w, h] of SIZES) {
  for (const [shape, block] of SHAPES) {
    test.describe(`${w}x${h}: a tight cluster of seven (${shape})`, () => {
      test.use({ viewport: { width: w, height: h } })

      /** The order activates the first, a middle one and the last, then goes back up the cluster. */
      const ORDER = [0, 3, 6, 4, 1] as const

      const ready = async (page: Page, server: ServerLike, tmpRoot: TmpRoot): Promise<string[]> => {
        await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: clusterDoc(12, block) })
        const threads = await seed(server, FILE, CLUSTER, BODIES)
        await expect(page.locator(sel('card'))).toHaveCount(CLUSTER.length)
        await scrollTextTo(page, CLUSTER[0], 160)
        await railSettled(page, 250)
        return threads
      }

      test('(a) clicking each highlight puts that card level with its line', async ({ page, server, tmpRoot }) => {
        const threads = await ready(page, server, tmpRoot)
        for (const i of ORDER) {
          await highlight(page, threads[i]!).click()
          await expectLevel(page, threads[i]!, `${CLUSTER[i]} by its highlight`)
          await expectOthersDrift(page)
        }
      })

      test('(b) clicking each card puts that card level with its line', async ({ page, server, tmpRoot }) => {
        const threads = await ready(page, server, tmpRoot)
        for (const i of ORDER) {
          await cardHead(page, threads[i]!).click()
          await expectLevel(page, threads[i]!, `${CLUSTER[i]} by its card`)
          await expectOthersDrift(page)
        }
      })
    })
  }
}

// ---- the other ways in: next/prev and the keyboard, and a window that changes size under an active card --------------------

test.describe('the other ways to make a card active', () => {
  test('next and previous, and Tab onto a card, leave it level with its line', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: clusterDoc(12) })
    const threads = await seed(server, FILE, CLUSTER, BODIES)
    await expect(page.locator(sel('card'))).toHaveCount(CLUSTER.length)
    await scrollTextTo(page, CLUSTER[0], 160)
    await railSettled(page, 250)
    await highlight(page, threads[0]!).click()
    await expectLevel(page, threads[0]!, `${CLUSTER[0]} to start`)
    for (const [button, i] of [['navNext', 1], ['navNext', 2], ['navNext', 3], ['navPrev', 2]] as const) {
      await page.locator(sel(button)).click()
      await expectLevel(page, threads[i]!, `${CLUSTER[i]} by ${button}`)
    }
    // focus from the keyboard (Tab lands on a card this way) activates a card in place, without moving the document
    await card(page, threads[2]!).focus()
    await expectLevel(page, threads[2]!, `${CLUSTER[2]} by focus`)
    await card(page, threads[5]!).focus()
    await expectLevel(page, threads[5]!, `${CLUSTER[5]} by focus`)
  })

  test('a window that changes size under an active card: the card follows its line to the new wrap', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: clusterDoc(12) })
    const threads = await seed(server, FILE, CLUSTER, BODIES)
    await expect(page.locator(sel('card'))).toHaveCount(CLUSTER.length)
    await scrollTextTo(page, CLUSTER[0], 160)
    await railSettled(page, 250)
    for (const i of [3, 6] as const) {
      await highlight(page, threads[i]!).click()
      await expectLevel(page, threads[i]!, `${CLUSTER[i]} at 1440x900`)
      await page.setViewportSize({ width: 1100, height: 700 })
      await expectLevel(page, threads[i]!, `${CLUSTER[i]} after the window shrank to 1100x700`)
      await page.setViewportSize({ width: 1440, height: 900 })
      await expectLevel(page, threads[i]!, `${CLUSTER[i]} after it grew back`)
    }
  })
})

// ---- (c) the last paragraph of a long document, with the dock closed and open --------------------------------------

for (const [w, h] of SIZES) {
  for (const open of [false, true]) {
    test.describe(`${w}x${h}, dock ${open ? 'open' : 'closed'}: a comment on the last paragraph`, () => {
      test.use({ viewport: { width: w, height: h } })

      test('the card is level with its line, clear of the dock, and so are its action rows', async ({ page, server, tmpRoot }) => {
        const LAST = 'marker59x'
        await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: railDoc(60) })
        const made = await claude(server, FILE, [{ op: 'comment', quote: LAST, body: MEDIUM_BODY }])
        const thread = made.results[0]!.thread!
        // a reply and a suggestion in the same thread: a tall card with Accept and Reject rows of its own
        await claude(server, FILE, [
          { op: 'reply', thread, body: MEDIUM_BODY },
          { op: 'suggest', quote: LAST, replace: 'marker59y', thread },
        ])
        await expect(card(page, thread).locator(sel('message'))).toHaveCount(2)
        await expect(card(page, thread).locator(sel('suggestionItem'))).toHaveCount(1)
        // short replies, one at a time, until the card is well over half the window: taller than the room the document
        // leaves under its last line, so the rail's own room under the card (and the dock's share of it) is what the end of
        // the scroll box is made of
        const clientH = await page.evaluate(() => document.getElementById('mdr-scroll')!.clientHeight)
        let messages = 2
        for (; (await card(page, thread).boundingBox())!.height < clientH * 0.6 && messages < 24; messages++) {
          await claude(server, FILE, [{ op: 'reply', thread, body: `Reply number ${messages}: is this still right for the term sheet?` }])
          await expect(card(page, thread).locator(sel('message'))).toHaveCount(messages + 1)
        }
        const tall = (await card(page, thread).boundingBox())!.height
        expect(tall, 'the card is tall, and still fits the window with room for its line').toBeGreaterThanOrEqual(clientH * 0.6)
        expect(tall).toBeLessThanOrEqual(clientH * 0.72)
        if (open) {
          await dockInput(page).click()
          await page.keyboard.type('One')
          for (const t of ['Two', 'Three', 'Four']) {
            await page.keyboard.press('Shift+Enter')
            await page.keyboard.type(t)
          }
          await expect(dock(page)).toHaveAttribute('data-open', 'true')
        }
        // the rail makes room for the dock's height one frame after the dock grows: let it, then go to the end
        await railSettled(page, 150)
        await scrollTo(page, 'end')
        await railSettled(page, 150)
        await highlight(page, thread).click()
        // the click scrolls nothing, and the rail kept room under the card when it was idle: it ends above the dock already
        await expectLevel(page, thread, 'last paragraph, just activated')
        const dockTop = (await dock(page).boundingBox())!.y
        const m = await level(page, thread)
        expect(m.cardBottom, `the card ends at ${m.cardBottom}, the dock starts at ${dockTop}`).toBeLessThanOrEqual(dockTop + 0.5)
        await scrollTo(page, 'end')
        await expectLevel(page, thread, 'last paragraph, at the end of the document')
        for (const [name, row] of [
          ['Accept and Reject', card(page, thread).locator(sel('suggestionItem'))],
        ] as const) {
          const b = (await row.boundingBox())!
          expect(b.y + b.height, `${name} row ends at ${b.y + b.height}, the dock starts at ${dockTop}`).toBeLessThanOrEqual(dockTop + 0.5)
        }

        // the reply box: open it and write three lines; the card grows, stays level, and Reply/Cancel clear the dock
        await card(page, thread).locator(sel('cardReply')).click()
        await page.keyboard.type('First line of the answer,\nsecond line of the answer,\nthird line of the answer.')
        await railSettled(page, 250)
        await scrollTo(page, 'end')
        await expectLevel(page, thread, 'last paragraph, reply box open')
        const actions = (await card(page, thread).locator('.mdr-composer-actions').boundingBox())!
        const dockTop2 = (await dock(page).boundingBox())!.y
        expect(actions.y + actions.height, `Reply and Cancel end at ${actions.y + actions.height}, the dock starts at ${dockTop2}`).toBeLessThanOrEqual(dockTop2 + 0.5)
      })
    })
  }
}

// ---- (d) Claude inserts a paragraph above the active card ----------------------------------------------------------

for (const [w, h] of SIZES) {
  test.describe(`${w}x${h}: Claude edits above the active card`, () => {
    test.use({ viewport: { width: w, height: h } })

    test('the active card follows its line down as paragraphs go in above it', async ({ page, server, tmpRoot }) => {
      await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: clusterDoc(12) })
      const threads = await seed(server, FILE, CLUSTER, BODIES)
      await expect(page.locator(sel('card'))).toHaveCount(CLUSTER.length)
      await scrollTextTo(page, CLUSTER[0], 160)
      await railSettled(page, 250)

      let inserted = 0
      const insert = async (afterQuote: string): Promise<void> => {
        const token = `ins${++inserted}x`
        const text = `An inserted paragraph from Claude, ${token}, with enough words in it to take two or three lines at this width, so that every anchor below it moves down by a good amount.`
        await claude(server, FILE, [{ op: 'insert_after', target: { quote: afterQuote }, markdown: text }])
        await expect(page.locator('#mdr-editor-host').getByText(token)).toBeVisible({ timeout: 10_000 })
        await railSettled(page, 400)
      }

      for (const i of [3, 6, 0] as const) {
        const t = threads[i]!
        await highlight(page, t).click()
        await expectLevel(page, t, `${CLUSTER[i]} active, before the edit`)
        // far above the cluster
        await insert('A short opening paragraph that sets things up')
        await expectLevel(page, t, `${CLUSTER[i]} after a paragraph went in far above it`)
        // inside the cluster, above the active card when it is not the first
        await insert(CLUSTER[1])
        await expectLevel(page, t, `${CLUSTER[i]} after a paragraph went in among the cards above it`)
      }
    })

    test('an active card on its own, with Claude inserting above it and a reply growing it', async ({ page, server, tmpRoot }) => {
      await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: railDoc(30) })
      const made = await claude(server, 'long.md', [{ op: 'comment', quote: 'marker12x', body: SHORT_BODY }])
      const thread = made.results[0]!.thread!
      await scrollTextTo(page, 'marker12x', 300)
      await highlight(page, thread).click()
      await expectLevel(page, thread, 'alone, before the edit')
      await claude(server, 'long.md', [
        { op: 'insert_after', target: { quote: 'A short opening paragraph that sets things up' }, markdown: 'A paragraph from Claude, long enough to take a few lines at this width and push the rest of the document down.' },
      ])
      await expect(page.locator('#mdr-editor-host').getByText('A paragraph from Claude, long enough')).toBeVisible({ timeout: 10_000 })
      await expectLevel(page, thread, 'alone, after a paragraph went in above it')
      await claude(server, 'long.md', [{ op: 'reply', thread, body: LONG_BODY }])
      await expect(card(page, thread).locator(sel('message'))).toHaveCount(2)
      await expectLevel(page, thread, 'alone, after a reply grew it')
    })
  })
}

// ---- the exception: an anchor above the header's bottom edge -------------------------------------------------------

test.describe('an anchor above the rail header', () => {
  test('the card waits under the header: its top is max(anchor top, header bottom)', async ({ page, server, tmpRoot }) => {
    const rest = railDoc(10).split('\n\n').slice(2).join('\n\n')
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: `# Title\n\nFirst paragraph carries tq0x and nothing else.\n\n${rest}\n` })
    // the settings panel opens in the header's flow, so the header is taller than the first line is low
    await openRailSettings(page)
    const made = await claude(server, FILE, [
      { op: 'comment', quote: 'tq0x', body: SHORT_BODY },
      { op: 'comment', quote: 'marker5x', body: SHORT_BODY },
    ])
    const [first, later] = made.results.map((r) => r.thread!) as [string, string]
    await expect(page.locator(sel('card'))).toHaveCount(2)
    await railSettled(page, 250)

    await highlight(page, first).click()
    const m = await expectLevel(page, first, 'first paragraph under a tall header')
    expect(m.headerBottom, 'the setup puts the line under the header').toBeGreaterThan(m.hlTop + 2)
    expect(Math.abs(m.cardTop - m.headerBottom)).toBeLessThanOrEqual(2)

    // a line further down, with room above it for the first card, is level with its card again
    await scrollTextTo(page, 'marker5x', 300)
    await highlight(page, later).click()
    const n = await expectLevel(page, later, 'a paragraph further down')
    expect(n.hlTop, 'and it is below the header').toBeGreaterThan(n.headerBottom)
  })
})

// ---- a crowded first paragraph, as near the header as a cluster gets while the cards above still fit --------------------

test.describe('a crowded first paragraph under the title', () => {
  test('every card in a crowded first paragraph, activated in turn, is level with its line', async ({ page, server, tmpRoot }) => {
    const toks = Array.from({ length: 8 }, (_, i) => `dq${i}x`)
    const sentences = toks.map((t, i) => `Sentence number ${i} carries ${t} and fills out its line with a few more words to wrap.`)
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: `# Title\n\n${sentences.join(' ')}\n\n${railDoc(8).split('\n\n').slice(2).join('\n\n')}\n` })
    const threads = await seed(server, FILE, toks, [SHORT_BODY, LONG_BODY])
    await expect(page.locator(sel('card'))).toHaveCount(toks.length)
    await railSettled(page, 250)
    for (const i of [0, 4, 7, 2, 5]) {
      await highlight(page, threads[i]!).click()
      await expectLevel(page, threads[i]!, `${toks[i]} in a crowded first paragraph`)
    }
  })
})
