/**
 * Phase 3 — image pipeline tests.
 * Synthetic images are generated with sharp itself; no fixtures, no network.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  SLIDE_W,
  SLIDE_H,
  processSlide,
  dhash,
  hammingDistance,
  brandAssetsAvailable,
  buildCoverSlide,
  BrandAssetsMissing,
} from "./images";

/** Build a deterministic raw 9×8 pattern image (for dhash, no resize ambiguity). */
async function patternPng(fill: (x: number, y: number) => number): Promise<Buffer> {
  const raw = Buffer.alloc(9 * 8 * 3);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const v = fill(x, y);
      raw[(y * 9 + x) * 3] = v;
      raw[(y * 9 + x) * 3 + 1] = v;
      raw[(y * 9 + x) * 3 + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: 9, height: 8, channels: 3 } }).png().toBuffer();
}

describe("processSlide", () => {
  it("outputs exactly 1080×1350 sRGB JPEG with no EXIF metadata", async () => {
    const input = await sharp({
      create: { width: 800, height: 1000, channels: 3, background: { r: 200, g: 60, b: 60 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const out = await processSlide(input);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(SLIDE_W);
    expect(meta.height).toBe(SLIDE_H);
    expect(meta.format).toBe("jpeg");
    expect(meta.space).toBe("srgb");
    // Metadata stripped: no EXIF block (GPS gone with it).
    expect(meta.exif).toBeUndefined();
  });

  it("honours EXIF orientation instead of shipping a sideways photo", async () => {
    // Stored 800×1000 but flagged orientation=6 (display rotated 90° CW).
    const input = await sharp({
      create: { width: 800, height: 1000, channels: 3, background: { r: 60, g: 60, b: 200 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 90 })
      .toBuffer();
    const before = await sharp(input).metadata();
    expect(before.orientation).toBe(6);

    const out = await processSlide(input);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(SLIDE_W);
    expect(meta.height).toBe(SLIDE_H);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it("never crops: a small image stays fully visible, centred on blurred fill", async () => {
    const input = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 220, b: 0 } },
    })
      .jpeg()
      .toBuffer();

    const out = await processSlide(input);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(SLIDE_W);
    expect(info.height).toBe(SLIDE_H);

    // Centre pixel sits inside the (enlarged but never cropped) foreground.
    const cx = Math.floor(SLIDE_W / 2);
    const cy = Math.floor(SLIDE_H / 2);
    const off = (cy * SLIDE_W + cx) * 3;
    const r = data[off] ?? 0;
    const g = data[off + 1] ?? 0;
    const b = data[off + 2] ?? 0;
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(120);
  });

  it("rejects empty input", async () => {
    await expect(processSlide(Buffer.alloc(0))).rejects.toThrow();
  });
});

describe("dhash + hammingDistance", () => {
  it("identical scenes hash to distance 0, robust to JPEG recompression", async () => {
    const pattern = await patternPng((x) => (x % 2 === 0 ? 0 : 255));
    const asPng = pattern;
    const asJpeg = await sharp(pattern).jpeg({ quality: 70 }).toBuffer();
    const h1 = await dhash(asPng);
    const h2 = await dhash(asJpeg);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance(h1, h2)).toBe(0);
  });

  it("genuinely different scenes are far apart (>10)", async () => {
    const stripes = await patternPng((x) => (x % 2 === 0 ? 0 : 255));
    const stripesInv = await patternPng((x) => (x % 2 === 0 ? 255 : 0));
    const dist = hammingDistance(await dhash(stripes), await dhash(stripesInv));
    expect(dist).toBeGreaterThan(10);
  });

  it("a one-pixel edit stays within the ≤6 duplicate threshold", async () => {
    const base = await patternPng((x) => (x % 2 === 0 ? 0 : 255));
    const edited = await patternPng((x, y) => (x === 0 && y === 0 ? 255 : x % 2 === 0 ? 0 : 255));
    const dist = hammingDistance(await dhash(base), await dhash(edited));
    expect(dist).toBeLessThanOrEqual(6);
    expect(dist).toBeGreaterThan(0);
  });

  it("hammingDistance unit cases", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    expect(() => hammingDistance("xyz", "0000000000000000")).toThrow();
  });
});

describe("cover slide gating", () => {
  it("brandAssetsAvailable() is false without brand assets", () => {
    // /brand ships with only a README (no colours.json); COVER_SLIDE_ENABLED=false in tests.
    expect(brandAssetsAvailable()).toBe(false);
  });

  it("buildCoverSlide throws BrandAssetsMissing instead of inventing a brand", async () => {
    await expect(
      buildCoverSlide({ price_pkr: 2500, size: "M", condition: "like_new", title: "Test" }),
    ).rejects.toBeInstanceOf(BrandAssetsMissing);
  });
});
