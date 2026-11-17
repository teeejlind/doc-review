// tests/unit/web/editor/frontmatter/panel.test.ts (P2; CONTRACTS §12.12 A, §12.15). The frontmatter panel in the live
// editor: the collapsed line and status chip, the expanded rows and their state attributes, one-line edits on disk
// (plain, quoted, add, remove), Edit YAML, the no-edit byte-identical round trip, collapse state per file, TOML and
// unrecognized YAML, and the Suggesting-mode block.
import { afterEach, describe, expect, it } from 'vitest'
import { TESTID } from '../../../../../shared/constants'
import { createEditor } from '../../../../../web/src/editor/index'
import { fixtureText } from '../../../core/status-header/corpus'
import { labelInNameProblem, mount, saved, type Mounted } from '../helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
  try {
    localStorage.clear()
  } catch {
    // storage blocked
  }
})

const q = <T extends HTMLElement = HTMLElement>(mm: Mounted, sel: string): T | null => mm.host.querySelector<T>(sel)
const panel = (mm: Mounted): HTMLElement => q(mm, `[data-testid="${TESTID.frontmatterPanel}"]`)!
const line = (mm: Mounted): HTMLElement => panel(mm).querySelector<HTMLElement>('.mdr-frontmatter__line')!
const row = (mm: Mounted, key: string): HTMLElement => panel(mm).querySelector<HTMLElement>(`[data-testid="${TESTID.frontmatterField}"][data-key="${key}"]`)!
const rowInput = (mm: Mounted, key: string): HTMLInputElement => row(mm, key).querySelector<HTMLInputElement>('input')!

function commit(input: HTMLInputElement, value: string): void {
  input.focus()
  input.value = value
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

/** Changed lines between two texts of equal line count. */
function changedLines(a: string, b: string): number[] {
  const x = a.split('\n')
  const y = b.split('\n')
  expect(y.length).toBe(x.length)
  return x.map((l, i) => (l === y[i] ? -1 : i)).filter((i) => i >= 0)
}

const COMPLEX = fixtureText('syn__frontmatter-complex.md')

describe('QA3: the collapsed line is named by what it shows (WCAG 2.5.3)', () => {
  it('its accessible name contains its visible text, collapsed and expanded, and still says what it is', async () => {
    m = await mount({ markdown: COMPLEX })
    expect(labelInNameProblem(line(m))).toBeNull()
    expect(line(m).getAttribute('aria-label')).toMatch(/^Document properties/)
    expect(line(m).getAttribute('aria-expanded')).toBe('false')
    line(m).click()
    expect(line(m).getAttribute('aria-expanded')).toBe('true')
    expect(labelInNameProblem(line(m))).toBeNull()
  })
})

describe('collapsed line (§12.12 A)', () => {
  it('shows the status chip and the field count; collapsed by default; remembered per file', async () => {
    m = await mount({ markdown: COMPLEX })
    expect(panel(m).dataset.expanded).toBe('false')
    expect(q(m, `[data-testid="${TESTID.frontmatterStatus}"]`)!.textContent).toBe('draft only · needs legal review')
    expect(line(m).textContent).toContain('6 fields')
    expect(panel(m).querySelector(`[data-testid="${TESTID.frontmatterField}"]`)).toBeNull()
    line(m).click()
    expect(panel(m).dataset.expanded).toBe('true')
    // a new editor on the same file opens expanded (localStorage, per root + file)
    m.handle.destroy()
    const again = await createEditor({ host: m.host, toolbarHost: m.toolbarHost, scrollContainer: m.scroll, session: m.session })
    try {
      expect(panel(m).dataset.expanded).toBe('true')
    } finally {
      again.destroy()
    }
  })

  it('clicking the line selects the atom: a comment on the frontmatter uses a block anchor (D35)', async () => {
    m = await mount({ markdown: COMPLEX })
    line(m).click()
    const t = m.bridge.getSelectionTarget()
    expect(t?.kind).toBe('block')
  })

  it('no status key: "Properties (N)"; Enter on the focused line expands', async () => {
    m = await mount({ markdown: '---\ntitle: A\nowner: TJ\n---\n\nBody.\n' })
    expect(q(m, `[data-testid="${TESTID.frontmatterStatus}"]`)).toBeNull()
    expect(line(m).textContent).toContain('Properties (2)')
    line(m).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(panel(m).dataset.expanded).toBe('true')
  })
})

describe('expanded rows and one-line edits', () => {
  it('rows carry data-key / data-kind / data-editable; multiline rows are read-only source with Edit YAML', async () => {
    m = await mount({ markdown: COMPLEX })
    line(m).click()
    const rows = [...panel(m).querySelectorAll<HTMLElement>(`[data-testid="${TESTID.frontmatterField}"]`)]
    expect(rows.map((r) => [r.dataset.key, r.dataset.kind, r.dataset.editable])).toEqual([
      ['title', 'double', 'true'], ['owner', 'plain', 'true'], ['tags', 'multiline', 'false'], ['summary', 'multiline', 'false'],
      ['status', 'plain', 'true'], ['empty', 'empty', 'true'],
    ])
    for (const r of rows.filter((x) => x.dataset.editable === 'true')) expect(r.querySelectorAll('input').length).toBe(1)
    expect(row(m, 'tags').querySelector('input')).toBeNull()
    expect(row(m, 'tags').querySelector(`[data-testid="${TESTID.editYaml}"]`)).not.toBeNull()
  })

  it('a plain-field edit, a quoted-field edit, an added key and a removed key each change one line on disk', async () => {
    m = await mount({ markdown: COMPLEX })
    line(m).click()
    commit(rowInput(m, 'owner'), 'Jordan')
    let out = await saved(m)
    expect(changedLines(COMPLEX, out)).toEqual([3])
    expect(out.split('\n')[3]).toBe('owner: Jordan')
    const afterOwner = out
    commit(rowInput(m, 'title'), 'New: "title"')
    out = await saved(m)
    expect(changedLines(afterOwner, out)).toEqual([2])
    expect(out.split('\n')[2]).toBe('title: "New: \\"title\\""')
    const afterTitle = out
    const key = panel(m).querySelector<HTMLInputElement>('[data-field="new-key"]')!
    const val = panel(m).querySelector<HTMLInputElement>('[data-field="new-value"]')!
    key.value = 'lane'
    val.value = 'PS'
    panel(m).querySelector<HTMLButtonElement>(`[data-testid="${TESTID.frontmatterAdd}"]`)!.click()
    out = await saved(m)
    const a = afterTitle.split('\n')
    const b = out.split('\n')
    expect(b.length).toBe(a.length + 1)
    expect(b.indexOf('lane: PS')).toBe(a.indexOf('empty:') + 1)
    const afterAdd = out
    panel(m).querySelector<HTMLButtonElement>(`[data-testid="${TESTID.frontmatterRemove}"][data-key="owner"]`)!.click()
    out = await saved(m)
    expect(out.split('\n').length).toBe(afterAdd.split('\n').length - 1)
    expect(out).not.toContain('owner:')
  })

  it('Edit YAML on a block-scalar field changes only the edited lines', async () => {
    m = await mount({ markdown: COMPLEX })
    line(m).click()
    row(m, 'summary').querySelector<HTMLButtonElement>(`[data-testid="${TESTID.editYaml}"]`)!.click()
    const pop = q(m, `[data-testid="${TESTID.yamlPopover}"]`)!
    const ta = pop.querySelector<HTMLTextAreaElement>(`[data-testid="${TESTID.popoverField}"][data-field="yaml"]`)!
    expect(ta.value).toBe(COMPLEX.split('\n---\n')[0]!.slice(4))
    ta.value = ta.value.replace('  summary text.', '  summary text, revised.')
    pop.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.popoverAction}"][data-action="save"]`)!.click()
    const out = await saved(m)
    expect(changedLines(COMPLEX, out)).toEqual([9])
  })

  it('a YAML panel round trip with no edit is byte-identical', async () => {
    m = await mount({ markdown: COMPLEX })
    line(m).click()
    line(m).click()
    line(m).click()
    rowInput(m, 'owner').dispatchEvent(new Event('blur'))
    expect(await saved(m)).toBe(COMPLEX)
    expect((globalThis as unknown as { __mdrDebug: { planSave(): unknown[] } }).__mdrDebug.planSave()).toEqual([])
  })

  it('CRLF frontmatter: a field edit and a raw edit keep CRLF on every line', async () => {
    const crlf = '---\r\ntitle: A\r\nstatus: draft # c\r\n---\r\n\r\nBody.\r\n'
    m = await mount({ markdown: crlf })
    line(m).click()
    commit(rowInput(m, 'status'), 'final')
    expect(await saved(m)).toBe('---\r\ntitle: A\r\nstatus: final # c\r\n---\r\n\r\nBody.\r\n')
    panel(m).querySelector<HTMLButtonElement>(`.mdr-frontmatter__foot [data-testid="${TESTID.editYaml}"]`)!.click()
    const pop = q(m, `[data-testid="${TESTID.yamlPopover}"]`)!
    const ta = pop.querySelector<HTMLTextAreaElement>('textarea')!
    ta.value = ta.value.replace('title: A', 'title: B')
    pop.querySelector<HTMLButtonElement>('[data-action="save"]')!.click()
    expect(await saved(m)).toBe('---\r\ntitle: B\r\nstatus: final # c\r\n---\r\n\r\nBody.\r\n')
  })

  it('a duplicate key: both rows warn, only the first is editable', async () => {
    m = await mount({ markdown: '---\nk: 1\nk: 2\n---\n\nBody.\n' })
    line(m).click()
    const rows = [...panel(m).querySelectorAll<HTMLElement>(`[data-testid="${TESTID.frontmatterField}"]`)]
    expect(rows.map((r) => r.dataset.editable)).toEqual(['true', 'false'])
    expect(rows.every((r) => r.querySelector('.mdr-frontmatter__warn'))).toBe(true)
  })
})

describe('TOML and unrecognized YAML', () => {
  it('TOML shows only the raw editor, with a note', async () => {
    m = await mount({ markdown: fixtureText('syn__frontmatter-toml.md') })
    line(m).click()
    expect(panel(m).querySelector(`[data-testid="${TESTID.frontmatterField}"]`)).toBeNull()
    expect(panel(m).querySelector('.mdr-frontmatter__note')!.textContent).toMatch(/TOML/)
    panel(m).querySelector<HTMLButtonElement>(`[data-testid="${TESTID.editYaml}"]`)!.click()
    const ta = q(m, `[data-testid="${TESTID.yamlPopover}"] textarea`) as HTMLTextAreaElement
    ta.value = ta.value.replace('draft only', 'final')
    q(m, `[data-testid="${TESTID.yamlPopover}"] [data-action="save"]`)!.click()
    expect(await saved(m)).toBe(fixtureText('syn__frontmatter-toml.md').replace('status = "draft only"', 'status = "final"'))
  })

  it('an unrecognized scan offers only Edit YAML; a fence line in the raw text is refused', async () => {
    m = await mount({ markdown: '---\nkey:value\n---\n\nBody.\n' })
    line(m).click()
    expect(panel(m).querySelector(`[data-testid="${TESTID.frontmatterField}"]`)).toBeNull()
    panel(m).querySelector<HTMLButtonElement>(`[data-testid="${TESTID.editYaml}"]`)!.click()
    const pop = q(m, `[data-testid="${TESTID.yamlPopover}"]`)!
    pop.querySelector<HTMLTextAreaElement>('textarea')!.value = 'a: 1\n---\nb: 2'
    pop.querySelector<HTMLButtonElement>('[data-action="save"]')!.click()
    expect(pop.querySelector('.mdr-popover__error')!.textContent).toMatch(/---/)
    expect(await saved(m)).toBe('---\nkey:value\n---\n\nBody.\n')
  })
})

describe('Suggesting mode (D14)', () => {
  it('focusing a field raises SUGGEST_MODE_BLOCKED; field, add and raw edits change nothing', async () => {
    m = await mount({ markdown: COMPLEX })
    line(m).click()
    m.bridge.setMode('suggesting')
    rowInput(m, 'owner').dispatchEvent(new Event('focus'))
    expect(m.notices.map((n) => n.code)).toContain('SUGGEST_MODE_BLOCKED')
    commit(rowInput(m, 'owner'), 'Nope')
    panel(m).querySelector<HTMLButtonElement>(`.mdr-frontmatter__foot [data-testid="${TESTID.editYaml}"]`)!.click()
    const save = q(m, `[data-testid="${TESTID.yamlPopover}"] [data-action="save"]`)!
    expect(save.getAttribute('aria-disabled')).toBe('true')
    save.click()
    expect(await saved(m)).toBe(COMPLEX)
  })
})
