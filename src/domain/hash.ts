// Non-cryptographic hash for fingerprints (spec 5.6). Pure: TextEncoder is a global, no node:* import.

const OFFSET_BASIS = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/** FNV-1a, 64 bits, over the UTF-8 bytes of s; 16 lower-case hex chars. */
export function fnv1a64(s: string): string {
  let h = OFFSET_BASIS;
  for (const byte of encoder.encode(s)) h = ((h ^ BigInt(byte)) * PRIME) & MASK;
  return h.toString(16).padStart(16, "0");
}
