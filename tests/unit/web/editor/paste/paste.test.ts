// tests/unit/web/editor/paste/paste.test.ts (P2; CONTRACTS §12.11). The paste fixtures: each
// fixtures/<source>-<case>.html is pasted into an empty doc through the real editor's paste path
// (EditorView.pasteHTML: transformPastedHTML → Milkdown's DOM parser → transformPasted → dispatch) and saved; the file
// must equal the sibling .md. Plus the normalizer's rules on their own, plain paste, lone-URL linking, the image
// notice, and the Suggesting-mode table block.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { normalizePasted, normalizePastedHTML } from '../../../../../web/src/editor/paste/normalize'
import { find, mount, type Mounted } from '../helpers'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const CASES = readdirSync(DIR).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -'.html'.length)).sort()

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

/** A paste event carrying the given clipboard flavours (jsdom has no DataTransfer constructor). */
function clip(data: Record<string, string>): ClipboardEvent {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => data[t] ?? '', types: Object.keys(data) } })
  return e
}

async function pasteIntoEmpty(html: string): Promise<{ saved: string; m: Mounted }> {
  m = await mount({ markdown: '' })
  m.view.focus()
  m.view.pasteHTML(html, clip({ 'text/html': html }))
  await m.session.flush()
  return { saved: m.fx.root.read('doc.md'), m }
}

describe('paste fixtures (§12.11): pasted into an empty doc and saved, the file equals the expected markdown', () => {
  it('has the contract minimum of fixtures', () => {
    for (const name of ['gdocs-basic', 'gdocs-lists', 'gdocs-table', 'gdocs-link', 'word-basic', 'word-lists-nested', 'word-table-merged', 'word-heading', 'web-article', 'web-table', 'web-relative-links', 'web-images']) {
      expect(CASES).toContain(name)
    }
  })

  for (const name of CASES) {
    it(name, async () => {
      const html = readFileSync(join(DIR, `${name}.html`), 'utf8')
      const { saved } = await pasteIntoEmpty(html)
      if (process.env.MDR_PRINT_PASTE) console.log(`----- ${name}\n${JSON.stringify(saved)}\n${saved}`)
      expect(saved).toBe(readFileSync(join(DIR, `${name}.md`), 'utf8'))
    })
  }
})

describe('normalizePastedHTML rules', () => {
  it('drops scripts, styles, forms, svg, comments and every class / style / id / data-* attribute', () => {
    const out = normalizePastedHTML('<style>p{}</style><p class="a" style="color:red" id="x" data-k="1">Hi<!-- c --><script>x()</script><svg></svg><button>b</button></p>')
    expect(out).toBe('<p>Hi</p>')
  })

  it('unwrapped block wrappers keep their paragraph boundaries', () => {
    expect(normalizePastedHTML('<div>one</div><div>two <span>three</span></div>')).toBe('<p>one</p><p>two three</p>')
    expect(normalizePastedHTML('<section><h2>T</h2>loose text</section>')).toBe('<h2>T</h2><p>loose text</p>')
  })

  it('relative links without a base are unwrapped to text; with sourceUrl they resolve; javascript: never links', () => {
    expect(normalizePastedHTML('<p><a href="/a">rel</a> <a href="javascript:x">js</a> <a href="https://x.com">abs</a></p>')).toBe('<p>rel js <a href="https://x.com">abs</a></p>')
    expect(normalizePastedHTML('<p><a href="b/c">rel</a></p>', { sourceUrl: 'https://site.com/a/' })).toBe('<p><a href="https://site.com/a/b/c">rel</a></p>')
  })

  it('nav / header / footer / aside are dropped only when there is other block content', () => {
    expect(normalizePastedHTML('<nav><a href="https://x.com">x</a></nav><p>Body</p>')).toBe('<p>Body</p>')
    expect(normalizePastedHTML('<nav><a href="https://x.com">Only nav</a></nav>')).toBe('<p><a href="https://x.com">Only nav</a></p>')
  })

  it('counts data:, blob: and other non-web images as dropped', () => {
    const r = normalizePasted('<p><img src="data:image/png;base64,AA=="><img src="blob:x"><img src="file:///C:/x.png"><img src="https://x.com/a.png" alt="a" title="t"></p>')
    expect(r.droppedImages).toBe(3)
    expect(r.html).toBe('<p><img src="https://x.com/a.png" alt="a"></p>')
  })

  it('ProseMirror clipboard HTML (data-pm-slice) passes through untouched', () => {
    const html = '<p data-pm-slice="1 1 []">x <strong>y</strong></p>'
    expect(normalizePasted(html)).toEqual({ html, droppedImages: 0, source: 'pm' })
  })

  it('a table with merged cells is filled out rectangular; the first row is the header', () => {
    const out = normalizePastedHTML('<table><tr><td colspan="2">A</td></tr><tr><td>b</td><td rowspan="2">c</td></tr><tr><td>d</td></tr></table>')
    expect(out).toBe('<table><thead><tr><th>A</th><th></th></tr></thead><tbody><tr><td>b</td><td>c</td></tr><tr><td>d</td><td></td></tr></tbody></table>')
  })
})

describe('paste behaviour in the editor', () => {
  it('raises PASTE_IMAGE_DROPPED for dropped images', async () => {
    const { m: mm } = await pasteIntoEmpty('<p>x <img src="data:image/png;base64,AA=="></p>')
    expect(mm.notices.map((n) => n.code)).toContain('PASTE_IMAGE_DROPPED')
  })

  it('Cmd+Shift+V inserts text/plain only, paragraphs split on blank lines', async () => {
    m = await mount({ markdown: 'Start.\n' })
    const r = find(m.view, 'Start.')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.to)))
    m.ed.runAction('paste-plain', m.view)
    m.view.pasteHTML('<p><b>ignored</b></p>', clip({ 'text/html': '<p><b>ignored</b></p>', 'text/plain': ' one\nline two\n\nSecond **para**' }))
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe('Start. one\nline two\n\nSecond \\*\\*para\\*\\*\n')
  })

  describe('plain text that is markdown (QA round 1: confirmed 23)', () => {
    const plain = async (start: string, text: string, flavours: Record<string, string> = {}): Promise<string> => {
      m = await mount({ markdown: start })
      m.view.focus()
      const doc = m.view.state.doc
      m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(doc, doc.content.size - (start ? 1 : 0))))
      m.view.pasteText(text, clip({ 'text/plain': text, ...flavours }))
      await m.session.flush()
      return m.fx.root.read('doc.md')
    }

    it('a terminal/Slack paste of headings, inline syntax and lists becomes those blocks, not escaped text', async () => {
      const out = await plain('', '## From terminal\n\nSome **bold** and `code`.\n\n- one\n- two\n')
      expect(out).toBe('## From terminal\n\nSome **bold** and `code`.\n\n- one\n- two\n')
      expect(out).not.toContain('\\')
    })

    it('a pasted table and a task list keep their syntax', async () => {
      const out = await plain('', '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] todo\n- [x] done\n')
      expect(out).toContain('| a | b |')
      expect(out).toContain('- [ ] todo')
      expect(out).not.toContain('\\')
    })

    it('one line of inline markdown pasted mid-paragraph stays inline', async () => {
      m = await mount({ markdown: 'Start end.\n' })
      const r = find(m.view, 'Start ')
      m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.to)))
      m.view.pasteText('see **this** and [a link](https://example.com) ', clip({ 'text/plain': 'see **this** and [a link](https://example.com) ' }))
      await m.session.flush()
      expect(m.fx.root.read('doc.md')).toBe('Start see **this** and [a link](https://example.com) end.\n')
    })

    it('ordinary text with a stray asterisk or underscore is still pasted as typed', async () => {
      const out = await plain('Start.\n', ' 5 * 3 and snake_case_name')
      expect(out).toBe('Start. 5 \\* 3 and snake_case_name\n')
    })

    it('Cmd+Shift+V keeps markdown literal', async () => {
      m = await mount({ markdown: 'Start.\n' })
      const r = find(m.view, 'Start.')
      m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.to)))
      m.ed.runAction('paste-plain', m.view)
      m.view.pasteText('**bold**', clip({ 'text/plain': '**bold**' }))
      await m.session.flush()
      expect(m.fx.root.read('doc.md')).toBe('Start.**bold**\n'.replace('**bold**', '\\*\\*bold\\*\\*'))
    })
  })

  it('a lone URL pasted over a selection links it', async () => {
    m = await mount({ markdown: 'Read the primer today.\n' })
    const r = find(m.view, 'primer')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.from, r.to)))
    m.view.pasteText('https://example.com/primer', clip({ 'text/plain': 'https://example.com/primer' }))
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe('Read the [primer](https://example.com/primer) today.\n')
  })

  it('pasting a table in Suggesting mode is blocked (D14); a text paste is tracked', async () => {
    m = await mount({ markdown: 'Para.\n' })
    m.bridge.setMode('suggesting')
    const r = find(m.view, 'Para.')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.to)))
    const before = m.view.state.doc
    m.view.pasteHTML('<table><tr><th>a</th></tr><tr><td>b</td></tr></table>', clip({}))
    expect(m.view.state.doc.eq(before)).toBe(true)
    expect(m.notices.map((n) => n.code)).toContain('SUGGEST_MODE_BLOCKED')
    m.view.pasteHTML('<p>more</p>', clip({}))
    expect(m.view.state.doc.textContent).toContain('more')
    expect([...m.bridge.getSuggestionSummaries().values()].some((s) => s.kind === 'insert')).toBe(true)
  })
})
