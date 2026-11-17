// tests/unit/core/md/create-md.test.ts (written by the integrator with the day-0 core/md adapter; P1 owns it from M0).
//
// CONTRACTS §3.2: one parser, headless and live; the fingerprint assertion on `extend`; the S2 upstream fixes ship.
import { $markSchema, $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { keymap } from '@milkdown/kit/prose/keymap'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStoreError } from '../../../../shared/errors'
import { CORE_VERSION } from '../../../../shared/version'
import { createMd, fingerprintOf, headlessFingerprint, SuggestionResidueError, type Md } from '../../../../core/md/index'

let md: Md

beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

describe('createMd() headless', () => {
  it('is the S2 schema: node names, the atom nodes, suggestion marks on doc', () => {
    const nodes = Object.keys(md.schema.nodes)
    for (const n of ['paragraph', 'heading', 'hardbreak', 'blockquote', 'code_block', 'hr', 'image', 'bullet_list', 'ordered_list',
      'list_item', 'html', 'table', 'table_header_row', 'table_row', 'table_header', 'table_cell', 'footnote_definition',
      'footnote_reference', 'frontmatter', 'raw_block']) {
      expect(nodes).toContain(n)
    }
    expect(nodes).not.toContain('thematic_break')
    expect(nodes).not.toContain('hard_break')
    for (const m of ['insertion', 'deletion', 'modification']) expect(Object.keys(md.schema.marks)).toContain(m)
    expect(md.schema.topNodeType.spec.marks).toBe('insertion modification deletion')
    expect(md.schema.nodes.code_block!.spec.attrs).toHaveProperty('meta')
  })

  it('carries the MdHandle identity', () => {
    expect(md.live).toBe(false)
    expect(md.coreVersion).toBe(CORE_VERSION)
    expect(md.schemaFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(md.schemaFingerprint).toBe(fingerprintOf(md.schema))
  })

  it('parses and serializes like Milkdown, with the stringify defaults', () => {
    const doc = md.parseDoc('* a\n* b\n\n***\n')
    const out = md.serializeNodes(doc.content.content)
    expect(out).toContain('- a')
    expect(out).toContain('---')
  })

  it('keeps titleless images (FINDINGS failure 1)', () => {
    const doc = md.parseDoc('Before ![alt](https://x.com/a.png) after.')
    let images = 0
    doc.descendants((n) => {
      if (n.type.name === 'image') images++
    })
    expect(images).toBe(1)
    expect(md.serializeNodes(doc.content.content)).toContain('![alt](https://x.com/a.png)')
  })

  it('keeps code-fence meta', () => {
    const doc = md.parseDoc('```ts title="x.ts"\nconst a = 1\n```\n')
    expect(doc.firstChild!.attrs.meta).toBe('title="x.ts"')
    expect(md.serializeNodes(doc.content.content)).toContain('```ts title="x.ts"')
  })

  it('parses frontmatter into the frontmatter atom and back', () => {
    const doc = md.parseDoc('---\ntitle: x\n---\n\nBody\n')
    expect(doc.firstChild!.type.name).toBe('frontmatter')
    expect(doc.firstChild!.attrs.value).toBe('title: x')
    expect(md.serializeNodes([doc.firstChild!])).toContain('title: x')
  })

  it('refuses to serialize a pending suggestion mark (R5.2)', () => {
    const doc = md.parseDoc('Hello world')
    const ins = md.schema.marks.insertion!.create({ id: 1 })
    const para = md.schema.nodes.paragraph!.create(null, md.schema.text('Hello', [ins]))
    expect(() => md.serializeNodes([para])).toThrow(SuggestionResidueError)
    try {
      md.serializeNodes([para])
    } catch (e) {
      expect(isStoreError(e) && e.code === 'SUGGESTION_RESIDUE').toBe(true)
    }
    expect(doc.textContent).toBe('Hello world')
  })

  it('mdastToDoc converts an already-transformed mdast root', () => {
    const tree = md.remark.runSync(md.remark.parse('# Title'), '# Title')
    expect(md.mdastToDoc(tree).firstChild!.type.name).toBe('heading')
  })
})

describe('fingerprint', () => {
  it('is deterministic across boots and equals headlessFingerprint()', async () => {
    const other = await createMd()
    try {
      expect(other.schemaFingerprint).toBe(md.schemaFingerprint)
      expect(await headlessFingerprint()).toBe(md.schemaFingerprint)
    } finally {
      await other.destroy()
    }
  })
})

describe('createMd({ extend })', () => {
  it('accepts view-only additions (a plugin) without changing the fingerprint', async () => {
    const withPlugin = await createMd({ extend: (e) => e.use($prose(() => new Plugin({}))) })
    try {
      expect(withPlugin.schemaFingerprint).toBe(md.schemaFingerprint)
    } finally {
      await withPlugin.destroy()
    }
  })

  it('accepts a keymap (and an input-rule-style plugin) without changing the fingerprint', async () => {
    const withKeys = await createMd({ extend: (e) => e.use($prose(() => keymap({ 'Mod-Alt-m': () => true, 'Mod-Enter': () => true }))) })
    try {
      expect(withKeys.schemaFingerprint).toBe(md.schemaFingerprint)
    } finally {
      await withKeys.destroy()
    }
  })

  it('throws CONTRACT_MISMATCH when extend adds a mark', async () => {
    const extraMark = $markSchema('mdr_extra', () => ({
      parseDOM: [{ tag: 'mark' }],
      toDOM: () => ['mark', 0],
      parseMarkdown: { match: () => false, runner: () => {} },
      toMarkdown: { match: () => false, runner: () => {} },
    }))
    const err = await createMd({ extend: (e) => e.use(extraMark) }).then(() => null, (e: unknown) => e)
    expect(isStoreError(err)).toBe(true)
    expect((err as { code: string }).code).toBe('CONTRACT_MISMATCH')
  })

  it('throws CONTRACT_MISMATCH when the caller expects another fingerprint', async () => {
    const err = await createMd({ expectFingerprint: '0000000000000000' }).then(() => null, (e: unknown) => e)
    expect((err as { code: string }).code).toBe('CONTRACT_MISMATCH')
  })

  it('passes when the expected fingerprint matches (the browser path)', async () => {
    const ok = await createMd({ expectFingerprint: md.schemaFingerprint })
    await ok.destroy()
  })
})

describe('createMd({ root }) live', () => {
  it('mounts the EditorView in the given element', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const live = await createMd({ root: host, expectFingerprint: md.schemaFingerprint })
    try {
      expect(live.live).toBe(true)
      expect(host.contains(live.view.dom)).toBe(true)
    } finally {
      await live.destroy()
      host.remove()
    }
  })
})
