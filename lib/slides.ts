/**
 * Slide rendering — sharp-only image ops (Phase 3).
 *
 * SHARP-ONLY module: it must never import satori (see lib/dhash.ts — the
 * harfbuzzjs `hb.wasm` file satori needs is not bundled on Vercel serverless,
 * and merely importing satori crashes the function process with an unhandled
 * rejection, exit 128; that crash took down finalize-photos on 2026-11-23).
 * The publish worker builds slides through here; the branded cover slide
 * (satori) lives in lib/images.ts and is only ever loaded behind its
 * brand-assets gate.
 */
import sharp from "sharp";

export const SLIDE_W = 1080;
export const SLIDE_H = 1350;

/**
 * Normalize one seller photo to the mandatory 4:5 canvas:
 *   1. .rotate() applies the EXIF orientation so the photo displays correctly,
 *      and the EXIF block is dropped afterwards.
 *   2. Two-pass background: blurred (sigma 40), darkened (55%) cover-fill
 *      copy of the SAME photo — no cropping of the clothing itself.
 *   3. Foreground: contain-fit inside 1080×1350, composited centered.
 *   4. sRGB JPEG q85 (mozjpeg). No .withMetadata() call → all metadata,
 *      including GPS, is stripped by sharp's default behaviour.
 *
 * Output is always exactly 1080×1350 — every carousel slide shares the first
 * slide's aspect ratio (Meta crops all slides to it), so uniformity is
 * mandatory, not cosmetic.
 */
export async function processSlide(input: Buffer): Promise<Buffer> {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new Error("processSlide: empty input buffer");
  }

  // Background pass: cover-fill → blur → darken. Re-read the input so the two
  // passes stay independent.
  const background = await sharp(input)
    .rotate()
    .resize(SLIDE_W, SLIDE_H, { fit: "cover" })
    .blur(40)
    .modulate({ brightness: 0.55 })
    .toColorspace("srgb")
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();

  // Foreground pass: contain-fit, never cropped, upscales small inputs.
  const foreground = await sharp(input)
    .rotate()
    .resize(SLIDE_W, SLIDE_H, { fit: "inside", withoutEnlargement: false })
    .toColorspace("srgb")
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  return sharp(background)
    .composite([{ input: foreground, gravity: "center" }])
    .toColorspace("srgb")
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
