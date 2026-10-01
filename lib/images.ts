/**
 * Image pipeline — Phase 3.
 *
 * - processSlide: normalize any input photo to an EXACT 1080×1350 (4:5)
 *   sRGB JPEG with ALL metadata stripped (no GPS/EXIF — never .withMetadata()).
 *   Non-cropping contain-fit over a blurred, darkened copy of itself.
 * - dhash / hammingDistance: 64-bit difference-hash duplicate detection.
 * - buildCoverSlide: optional branded first slide (satori → SVG → sharp).
 *   NEVER invents brand assets: throws BrandAssetsMissing unless
 *   COVER_SLIDE_ENABLED && /brand/colours.json exist. The cover slide stays
 *   OFF until Asim provides logo/colours/voice (see brand/README.md).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import satori, { type Font as SatoriFontOpt, type FontWeight } from "satori";
import { createElement as h } from "react";
import { z } from "zod";
import { getEnv } from "./env";

export const SLIDE_W = 1080;
export const SLIDE_H = 1350;

/** Thrown when the branded cover slide is requested but assets are missing. */
export class BrandAssetsMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandAssetsMissing";
  }
}

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

// ---------------------------------------------------------------------------
// Cover slide (gated by brand assets + COVER_SLIDE_ENABLED)
// ---------------------------------------------------------------------------

const coloursSchema = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
type BrandColours = z.infer<typeof coloursSchema>;

function brandDir(): string {
  return path.join(process.cwd(), "brand");
}

function coloursPath(): string {
  return path.join(brandDir(), "colours.json");
}

function loadColours(): BrandColours {
  let raw: string;
  try {
    raw = fs.readFileSync(coloursPath(), "utf-8");
  } catch {
    throw new BrandAssetsMissing(
      `Cover slide needs /brand/colours.json — not provided yet (see brand/README.md).`,
    );
  }
  const parsed = coloursSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new BrandAssetsMissing(`/brand/colours.json is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Gate: the cover slide may only be built when explicitly enabled AND the
 * brand colours file exists. Never true on invented/missing assets.
 */
export function brandAssetsAvailable(): boolean {
  if (!getEnv().COVER_SLIDE_ENABLED) return false;
  try {
    loadColours();
    return true;
  } catch {
    return false;
  }
}

/** Load fonts for satori: /brand/fonts first, then common system fonts. */
function loadFonts(): SatoriFontOpt[] {
  const found: { file: string; weight: FontWeight }[] = [];
  const fontDir = path.join(brandDir(), "fonts");
  if (fs.existsSync(fontDir)) {
    for (const f of fs.readdirSync(fontDir)) {
      if (/\.(ttf|otf|woff2?)$/i.test(f)) {
        found.push({ file: path.join(fontDir, f), weight: /bold|700/i.test(f) ? 700 : 400 });
      }
    }
  }
  const systemCandidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  ];
  for (const f of systemCandidates) {
    if (fs.existsSync(f)) {
      found.push({ file: f, weight: /bold/i.test(f) ? 700 : 400 });
    }
  }
  if (found.length === 0) {
    throw new BrandAssetsMissing(
      "Cover slide needs a font: put .ttf/.otf files in /brand/fonts (or install system fonts).",
    );
  }
  return found.map(({ file, weight }) => {
    const buf = fs.readFileSync(file);
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return { name: "RevaultBrand", data, weight, style: "normal" as const };
  });
}

export interface CoverSlideOpts {
  price_pkr: number;
  size: string | null;
  condition: string | null;
  title: string;
}

function formatPricePKR(price_pkr: number): string {
  return `Rs ${Math.round(price_pkr).toLocaleString("en-US")}`;
}

/**
 * Build the optional branded cover slide (logo + price + size/condition).
 * Gate: throws BrandAssetsMissing unless brandAssetsAvailable().
 */
export async function buildCoverSlide(opts: CoverSlideOpts): Promise<Buffer> {
  if (!brandAssetsAvailable()) {
    throw new BrandAssetsMissing(
      "Cover slide is disabled or brand assets are missing — set COVER_SLIDE_ENABLED=true and add /brand/colours.json (+ logo.png).",
    );
  }
  const colours = loadColours();
  const fonts = loadFonts();

  const logoPath = path.join(brandDir(), "logo.png");
  const hasLogo = fs.existsSync(logoPath);

  const chips: string[] = [];
  if (opts.size) chips.push(`Size: ${opts.size}`);
  if (opts.condition) chips.push(opts.condition);

  const element = h(
    "div",
    {
      style: {
        width: SLIDE_W,
        height: SLIDE_H,
        backgroundColor: colours.background,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 90,
        fontFamily: "RevaultBrand",
        color: colours.text,
      },
    },
    hasLogo
      ? h("img", {
          src: `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`,
          width: 420,
          style: { marginBottom: 70 },
        })
      : h("div", {
          style: {
            display: "flex",
            fontSize: 44,
            fontWeight: 700,
            letterSpacing: 10,
            color: colours.primary,
            marginBottom: 70,
          },
        }, "REVAULT"),
    h(
      "div",
      {
        style: {
          display: "flex",
          fontSize: 62,
          fontWeight: 700,
          textAlign: "center",
          lineHeight: 1.25,
          marginBottom: 50,
        },
      },
      opts.title.slice(0, 120),
    ),
    h(
      "div",
      { style: { display: "flex", fontSize: 96, fontWeight: 700, color: colours.accent, marginBottom: 50 } },
      formatPricePKR(opts.price_pkr),
    ),
    h(
      "div",
      { style: { display: "flex", gap: 24 } },
      ...chips.map((chip) =>
        h(
          "div",
          {
            style: {
              display: "flex",
              fontSize: 40,
              fontWeight: 700,
              color: colours.background,
              backgroundColor: colours.primary,
              borderRadius: 999,
              padding: "18px 44px",
            },
          },
          chip,
        ),
      ),
    ),
  );

  const svg = await satori(element, {
    width: SLIDE_W,
    height: SLIDE_H,
    fonts,
  });

  return sharp(Buffer.from(svg))
    .resize(SLIDE_W, SLIDE_H, { fit: "fill" })
    .toColorspace("srgb")
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
