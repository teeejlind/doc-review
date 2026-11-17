// tests/unit/web/rail/overlays.test.ts (P3; CONTRACTS §11.4).
//
// The floating Comment button's y clamp, the off-screen pill's edge, the 30% scroll target, and anchor ticks.
import { describe, expect, it } from 'vitest'
import { anchorScrollTop, FLOAT_EDGE, SHEET_STRIP_EDGE, SHEET_STRIP_LINE, stripScrollTop, floatingButtonY, offscreenDirection, ticksFor, TICK_DISPLACEMENT } from '../../../../web/src/rail/overlays'

const H = 30
const target = (top: number, extentBottom: number) => ({ rect: { top }, extent: { top, bottom: extentBottom } })

describe('floating Comment button y (§11.4)', () => {
  const view = { top: 1000, bottom: 1800 }

  it('starts level with the selection’s first line', () => {
    expect(floatingButtonY(target(1200, 1400), view, H)).toBe(1200)
    // a one-line selection: the upper bound (extent.bottom − 8 − height) lifts it to stay within the selection
    expect(floatingButtonY(target(1200, 1224), view, H)).toBe(1224 - FLOAT_EDGE - H)
  })

  it('rides the top edge while the first line is scrolled off and the selection continues on screen', () => {
    // a 3-paragraph selection that starts above the fold
    expect(floatingButtonY(target(600, 1500), view, H)).toBe(view.top + FLOAT_EDGE)
  })

  it('stays above the visible end of the selection: min(extent.bottom, viewBottom) − 8 − height', () => {
    expect(floatingButtonY(target(1780, 1900), view, H)).toBe(view.bottom - FLOAT_EDGE - H)
    expect(floatingButtonY(target(1750, 1790), view, H)).toBe(1750)
    // a selection taller than the viewport, scrolled to its middle: clamped to the top edge
    expect(floatingButtonY(target(200, 5000), view, H)).toBe(view.top + FLOAT_EDGE)
  })

  it('keeps to the visible band when only a sliver of the selection shows', () => {
    const y = floatingButtonY(target(900, 1004), view, H)!
    expect(y).toBeGreaterThanOrEqual(view.top)
    expect(y + H).toBeLessThanOrEqual(view.bottom)
  })

  it('hides when the whole selection is off screen (above or below)', () => {
    expect(floatingButtonY(target(100, 400), view, H)).toBeNull()
    expect(floatingButtonY(target(2000, 2100), view, H)).toBeNull()
  })
})

describe('off-screen pill (§11.4)', () => {
  const view = { top: 1000, bottom: 1800 }
  it('points up when the card is entirely above the band, down when entirely below, nothing while any of it shows', () => {
    expect(offscreenDirection({ top: 800, height: 150 }, view)).toBe('up')
    expect(offscreenDirection({ top: 1800, height: 150 }, view)).toBe('down')
    expect(offscreenDirection({ top: 900, height: 150 }, view)).toBeNull()
    expect(offscreenDirection({ top: 1790, height: 150 }, view)).toBeNull()
  })
})

describe('next/prev and pill scroll target (§11.4)', () => {
  it('puts the anchor 30% from the top, never above 0', () => {
    expect(anchorScrollTop(1300, 1000)).toBe(1000)
    expect(anchorScrollTop(100, 1000)).toBe(0)
  })
})

describe('narrow mode: the anchor stays in the strip above the sheet (§11.4)', () => {
  // the document shows `strip` px above the sheet at its tallest
  const strip = 150

  it('leaves the scroll alone while the anchor is already inside the strip', () => {
    expect(stripScrollTop(1300, 1250, strip)).toBe(1250)
    expect(stripScrollTop(1000 + SHEET_STRIP_EDGE, 1000, strip)).toBe(1000)
    expect(stripScrollTop(1000 + strip - SHEET_STRIP_LINE, 1000, strip)).toBe(1000)
  })

  it('scrolls an anchor that is under the sheet, or above the visible part, to 30% of the strip', () => {
    expect(stripScrollTop(1700, 1000, strip)).toBe(Math.round(1700 - strip * 0.3))
    expect(stripScrollTop(1000 + strip - SHEET_STRIP_LINE + 1, 1000, strip)).toBe(Math.round(1000 + strip - SHEET_STRIP_LINE + 1 - strip * 0.3))
    expect(stripScrollTop(900, 1000, strip)).toBe(Math.round(900 - strip * 0.3))
  })

  it('never scrolls above 0', () => {
    expect(stripScrollTop(10, 500, strip)).toBe(0)
  })
})

describe('anchor ticks (§11.4)', () => {
  it('a card displaced more than 24 px gets a tick at its anchor', () => {
    const ticks = ticksFor([
      { id: 'a', top: 100, displacement: 0 },
      { id: 'b', top: 300, displacement: TICK_DISPLACEMENT },
      { id: 'c', top: 500, displacement: TICK_DISPLACEMENT + 1 },
      { id: 'd', top: 40, displacement: -60 },
    ])
    expect(ticks).toEqual([
      { id: 'c', anchorY: 500 - TICK_DISPLACEMENT - 1, cardTop: 500 },
      { id: 'd', anchorY: 100, cardTop: 40 },
    ])
  })
  it('the active card always gets its tick, level with its anchor, even when it is not displaced (TJ, 2026-11-16)', () => {
    const placements = [
      { id: 'a', top: 100, displacement: 0 },
      { id: 'b', top: 520, displacement: 300 },
    ]
    expect(ticksFor(placements, 'a')).toEqual([
      { id: 'a', anchorY: 100, cardTop: 100 },
      { id: 'b', anchorY: 220, cardTop: 520 },
    ])
    expect(ticksFor(placements, null)).toEqual([{ id: 'b', anchorY: 220, cardTop: 520 }])
    expect(ticksFor(placements, 'gone')).toEqual([{ id: 'b', anchorY: 220, cardTop: 520 }])
  })
})
