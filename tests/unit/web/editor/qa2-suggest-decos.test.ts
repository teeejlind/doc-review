// tests/unit/web/editor/qa2-suggest-decos.test.ts (QA fix pass 2, agent A: confirmed 17). A block-level suggestion's
// decoration survives the hydration of the suggestion next to it.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const MD = '# T\n\nSecond paragraph stays as is.\n\n- Alpha item\n- Beta item\n- Gamma item\n\nClosing paragraph.\n'

describe('suggestion decorations next to each other', () => {
  it('an inserted paragraph keeps its decoration when the list right after it gets a suggestion', async () => {
    m = await mount({
      markdown: MD,
      claude: [
        { op: 'suggest', quote: 'Second paragraph stays as is.', replace: 'Second paragraph stays as is.\n\nA brand new paragraph follows.' },
        { op: 'suggest', quote: 'Gamma item', replace: 'Gamma item\n- Delta item' },
      ],
    })
    const owner = (text: string) => {
      const el = Array.from(m!.host.querySelectorAll<HTMLElement>('.ProseMirror p')).find((p) => p.textContent === text)
      return el?.closest<HTMLElement>('[data-suggestion]') ?? null
    }
    expect(owner('A brand new paragraph follows.')?.dataset.kind).toBe('ins')
    expect(owner('Delta item')?.dataset.kind).toBe('ins')
    expect(owner('Gamma item')).toBeNull()
  })
})
