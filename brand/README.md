# /brand — ReVault brand assets

This directory holds the brand assets used by the optional **cover slide**
(first carousel slide: logo, price PKR, size, condition) and the caption
**voice guide**.

## Status: EMPTY (by design)

Asim has not provided brand assets yet. **Do not invent a logo, colours, or
voice** — `COVER_SLIDE_ENABLED=false` until real assets land here.

## What to add (when Asim provides them)

| File | Purpose |
|------|---------|
| `logo.png` | ReVault logo, transparent background, ≥ 1080px wide. Used on the cover slide. |
| `colours.json` | `{ "primary": "#hex", "accent": "#hex", "background": "#hex", "text": "#hex" }` |
| `voice.md` | Caption tone guide: 3–5 example captions in Asim's voice + do/don't list. |

When these exist, set `COVER_SLIDE_ENABLED=true` in the environment and the
image pipeline will prepend the branded cover slide automatically.

## Voice fallback (until voice.md arrives)

Friendly Roman-Urdu + English mix, short lines, honest about defects, no
hype words ("amazing deal!!!"), no seller personal info, 3–5 hashtags max.
