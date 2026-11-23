/**
 * Perceptual hashing — duplicate detection (Phase 3).
 *
 * SHARP-ONLY module: it must never import satori (or anything that pulls a
 * WASM asset). The finalize worker runs on Vercel serverless, where the
 * harfbuzzjs `hb.wasm` file satori needs is NOT bundled (Next.js file tracing
 * cannot see the dynamic wasm path) — at runtime the missing file aborts the
 * module with `Aborted(Error: ENOENT ... '/ROOT/node_modules/harfbuzzjs/
 * hb.wasm')`, an unhandled rejection that kills the whole function process
 * (exit 128). That crash took down finalize-photos on 2026-11-23 even though
 * finalize never calls satori — merely importing lib/images.ts (which imports
 * satori) was enough. Keep this module WASM-free so the finalize +
 * moderation path can never load it. The branded cover slide (satori) lives
 * in lib/images.ts and is only ever used behind its brand-assets gate.
 */
import sharp from "sharp";

/**
 * 64-bit dHash as 16 lowercase hex chars.
 * Grayscale → 9×8 → each bit = (pixel[x] < pixel[x+1]), MSB-first.
 * Robust to recompression/resize/re-encode; two visually identical photos
 * hash to distance 0.
 */
export async function dhash(buf: Buffer): Promise<string> {
  const raw = await sharp(buf)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  if (raw.length < 72) throw new Error("dhash: unexpected raw buffer size");

  let hex = "";
  for (let y = 0; y < 8; y++) {
    for (let bx = 0; bx < 8; bx += 4) {
      let nibble = 0;
      for (let k = 0; k < 4; k++) {
        const x = bx + k;
        const left = raw[y * 9 + x] ?? 0;
        const right = raw[y * 9 + x + 1] ?? 0;
        nibble = (nibble << 1) | (left < right ? 1 : 0);
      }
      hex += nibble.toString(16);
    }
  }
  return hex;
}

/** Hamming distance between two 16-hex-char dHashes (0..64). */
export function hammingDistance(a: string, b: string): number {
  const re = /^[0-9a-f]{16}$/i;
  if (!re.test(a) || !re.test(b)) {
    throw new Error("hammingDistance: hashes must be 16 hex chars");
  }
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    let xor = parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16);
    while (xor) {
      dist += xor & 1;
      xor >>>= 1;
    }
  }
  return dist;
}
