// CRC-32 and Adler-32, the two checksums a png needs.
//
// Both tables are built once on first use rather than written out, because a
// 256 entry table transcribed by hand is a table with a typo in it and the
// symptom is a file that every decoder rejects with no clue which byte.

let crcTable = null

function buildCRC() {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
}

export function crc32(bytes, seed = 0) {
  if (!crcTable) crcTable = buildCRC()
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* the modulo is applied every 5552 bytes rather than every byte: that is the
 * largest run that cannot overflow a 32 bit accumulator, and doing it per byte
 * roughly halves the throughput for no benefit */
export function adler32(bytes) {
  let a = 1
  let b = 0
  let i = 0
  while (i < bytes.length) {
    const end = Math.min(i + 5552, bytes.length)
    for (; i < end; i++) {
      a += bytes[i]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}

export function crcOfString(s) {
  return crc32(new TextEncoder().encode(s))
}

/* a short stable id from any bytes, which is what names a cached derivative so
 * two identical inputs land on the same file */
export function shortHash(bytes, length = 8) {
  const a = crc32(bytes)
  const b = adler32(bytes)
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, length)
}
