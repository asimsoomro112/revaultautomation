/**
 * Branded cover slide — satori ONLY (Phase 3).
 *
 * WARNING: importing this module loads satori, which loads harfbuzzjs
 * `hb.wasm`. That wasm file is NOT bundled into Vercel serverless functions
 * (Next.js file tracing cannot see the dynamic wasm path) — at runtime the
 * missing file aborts with `Aborted(Error: ENOENT ... 'hb.wasm')`, an
 * unhandled rejection that kills the whole function process (exit 128). On
 * 2026-11-23 that crash took down finalize-photos even though finalize never
 * calls satori — merely importing this module was enough. NEVER import this
 * module from a worker route (or anything a worker route imports). The
 * sharp-only ops live in lib/dhash.ts (dhash/hammingDistance) and
 * lib/slides.ts (processSlide). The cover slide stays OFF until brand assets
 * exist (see brand/README.md); when it is ever wired in, load it with a
 * dynamic import() inside the brand-assets gate, never a top-level import.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import satori, { type Font as SatoriFontOpt, type FontWeight } from "satori";
import { createElement as h } from "react";
import { z } from "zod";
import { getEnv } from "./env";
import { SLIDE_W, SLIDE_H } from "./slides";

/** Thrown when the branded cover slide is requested but assets are missing. */
export class BrandAssetsMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandAssetsMissing";
  }
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
