// core/hash.ts (P1; real on day 0, CONTRACTS §0.4, §3.4, D40). Isomorphic: @noble/hashes, sync on both sides.
//
// - Doc hash: sha256 hex of the RAW file bytes, BOM included. From text: docHash(text, bom) =
//   sha256((bom ? EF BB BF : '') ‖ utf8(text)).
// - Block hash: the first 16 hex chars of sha256(utf8(src.slice(start, end))).
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import type { BlockHash, Hash } from '../shared/types'

const BOM_BYTES = new Uint8Array([0xef, 0xbb, 0xbf])

/** Lowercase sha256 hex of a string's UTF-8 bytes (or of raw bytes). */
export function sha256Hex(input: string | Uint8Array): Hash {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input))
}

/** sha256((bom ? EF BB BF : '') ‖ utf8(text)): the hash of the bytes on disk (D40). */
export function docHash(text: string, bom: boolean): Hash {
  const body = utf8ToBytes(text)
  return bytesToHex(sha256(bom ? concatBytes(BOM_BYTES, body) : body))
}

/** First 16 hex of sha256(utf8(block source slice)). */
export function blockHash(src: string): BlockHash {
  return sha256Hex(src).slice(0, 16)
}
