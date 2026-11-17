// tests/unit/core/eol/eol.test.ts (P1; CONTRACTS §0.4 EOL, §3.1 mixed EOLs) and the hash domain (§0.4, D40).
import { describe, expect, it } from 'vitest'
import { convertEol, detectEol, hasFinalEol, lineAt, lineStarts } from '../../../../core/eol'
import { blockHash, docHash, sha256Hex } from '../../../../core/hash'

describe('eol', () => {
  it('detectEol: CRLF only when CRLF lines outnumber bare LF lines', () => {
    expect(detectEol('')).toBe('\n')
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(detectEol('a\r\nb\nc\n')).toBe('\n')
    expect(detectEol('no newline')).toBe('\n')
  })

  it('convertEol rewrites every line ending to the target', () => {
    expect(convertEol('a\r\nb\nc', '\n')).toBe('a\nb\nc')
    expect(convertEol('a\r\nb\nc', '\r\n')).toBe('a\r\nb\r\nc')
  })

  it('lineStarts / lineAt are 1-based and count \\n only (a CR belongs to its line)', () => {
    const src = 'one\r\ntwo\nthree'
    const starts = lineStarts(src)
    expect(starts).toEqual([0, 5, 9])
    expect(lineAt(starts, 0)).toBe(1)
    expect(lineAt(starts, 4)).toBe(1)
    expect(lineAt(starts, 5)).toBe(2)
    expect(lineAt(starts, 13)).toBe(3)
  })

  it('hasFinalEol', () => {
    expect(hasFinalEol('a\n')).toBe(true)
    expect(hasFinalEol('a\r\n')).toBe(true)
    expect(hasFinalEol('a')).toBe(false)
  })
})

describe('hash domain (D40)', () => {
  it('docHash is over the raw bytes with the BOM; blockHash is 16 hex of the slice', () => {
    expect(docHash('abc', true)).toBe(sha256Hex(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63])))
    expect(docHash('abc', false)).toBe(sha256Hex('abc'))
    expect(blockHash('abc')).toBe(sha256Hex('abc').slice(0, 16))
    expect(blockHash('é😀')).toMatch(/^[0-9a-f]{16}$/)
  })
})
