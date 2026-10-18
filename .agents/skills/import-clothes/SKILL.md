---
name: import-clothes
description: Extract unique garments from outfit or model photos, reconstruct clean transparent clothing cutouts, generate identity-preserving modeled editorial photos, and import approved items directly into this Wardrobe project's local JSON database. Use when a user asks to add, ingest, extract, or import clothes from a folder of photos into Wardrobe, wants modeled photos for imported pieces, or wants finished wardrobe PNGs without using the in-app import flow.
---

# Import Clothes

Turn photos of worn clothing into source-faithful transparent catalog PNGs and modeled editorial photos, then add the approved results to the local Wardrobe database.

## Inputs

Obtain the source-image folder unless the user already supplied it. Resolve relative paths from the repository root. Confirm this is the Wardrobe repository by checking for `package.json` and `apps/backend/src/cli/`. Run `bun install` if `node_modules/` is missing. Confirm `.env` sets `GEMINI_API_KEY` (for generation) and `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (for reaching the deployed wardrobe at `WARDROBE_API_URL`, default `https://wardrobe.capon.io`).

At the start, run `bun run library:pull -- --out "$WORK/library"` to fetch the identity reference the user uploaded in the app (`$WORK/library/model-reference.png`). If it reports `modelReference: null`, ask: `Please provide a clear photo of yourself for the modeled wardrobe images. What is its local path?` Do not begin modeled generation until you have one. Keep the image local and never add it to Git.

Default to importing into the wardrobe when the user asks to add clothes to Wardrobe. If they only request cutouts, ask for a new output-folder name instead and skip the import step.

## Rules

- Generate every image with Gemini through `bun run image:generate` (see [Gemini tools](#gemini-tools)). Do not use any other image generator.
- Preserve every source image unchanged.
- Produce one clothing item per PNG, except an established matching pair such as shoes.
- Remove the wearer, skin, hair, mannequin, hanger, props, other layers, and scene.
- Preserve only source-supported color, material, silhouette, construction, pattern, and legible marks.
- Prefer omission over invented logos, text, pockets, seams, fasteners, hardware, or trim.
- Deduplicate only when source photographs establish that two appearances are the same physical item.
- Hold items whose defining construction cannot be recovered without substantial invention.
- Never place temporary crops, prompts, manifests, or QA files in the repository.

## Gemini tools

Run these from the repository root. They read `GEMINI_API_KEY` and the optional `GEMINI_IMAGE_MODEL` (default `gemini-3-pro-image`, Nano Banana Pro) from `.env`.

```bash
# Generate one image. Pass references in the order the prompt names them (Image 1, Image 2, ...).
bun run image:generate -- --prompt "$WORK/prompts/SLUG.txt" --image REF1.jpg [--image REF2.png] \
  --out OUT.png [--aspect 1:1|3:2|...] [--size 1K|2K|4K]

# Make a flat chroma-key background transparent and frame the item on a 1024px canvas.
bun run image:remove-background -- --input "$WORK/chroma/SLUG.png" --out "$WORK/items/SLUG.png" \
  --key "#00ff00" [--tolerance 46]
```

Write each prompt to a file first so it can be reviewed and reused. Nano Banana Pro accepts at most 14 reference images per call.

## Parallel work

Use subagents for large source folders or more than eight generated items when the current environment supports them. Give each worker a disjoint set of source files or manifest slugs and require it to return the slug, prompt, reference paths, chroma path, modeled path, and visual-review notes.

Keep one main agent responsible for the global item inventory, physical-identity deduplication, manifest reconciliation, database write, and final contact-sheet QA. Never let two workers generate or write the same slug. Run batches in waves when concurrency is limited, and resume only missing or failed slugs.

## Temporary workspace

Work outside the repository data directory:

```bash
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wardrobe-import.XXXXXX")"
mkdir -p "$WORK"/{source-jpg,crops,chroma,items,modeled,qa}
```

Keep all intermediate files under `$WORK`. Delete it only after delivery succeeds.

## Workflow

### 1. Inventory sources

Use `rg --files` first. Include JPEG, PNG, WebP, HEIC/HEIF, TIFF, BMP, and AVIF. Exclude `dist/`, `node_modules/`, and `.git/`.

Create upright RGB JPEG working copies at quality 95 or better without upscaling. Make labeled contact sheets of at most 12 photos and inspect every sheet. Inventory every deliberately worn top, jacket, bottom, accessory, and pair of shoes.

### 2. Build the manifest

Write `$WORK/manifest.json` using this final shape:

```json
{
  "items": [
    {
      "slug": "navy-fair-isle-cardigan",
      "file": "navy-fair-isle-cardigan.png",
      "modeledFile": "navy-fair-isle-cardigan.png",
      "name": "Navy Fair Isle Cardigan",
      "part": "wholebody_up",
      "color": "#172033",
      "secondaryColor": "#f2efe6",
      "tags": ["knit", "fair isle", "zip"],
      "status": "accepted",
      "sourceRefs": ["IMG_1284.jpg", "IMG_1289.jpg"],
      "unknowns": []
    }
  ]
}
```

Use only these `part` values:

- `upperbody` — tops
- `wholebody_up` — jackets and outerwear
- `lowerbody` — bottoms
- `accessories_up` — accessories
- `shoes` — shoes

Use lowercase hyphenated slugs, six-digit hex colors, at most 12 short lowercase tags, and `null` when there is no genuinely distinct secondary color. Keep working records as `status: "generate"` or `status: "hold"`; change a record to `accepted` only after final QA. The import script ignores every non-accepted record.

### 3. Prepare focused references

For each generated item, crop the strongest view with about 12% padding and preserve enough context to distinguish the target from underlayers. Add at most one complementary crop when it shows important construction unavailable in the primary view. Inspect labeled crop contact sheets before generation.

### 4. Generate evidence-bound cutouts

Run `bun run image:generate` with the primary crop and only a genuinely complementary second crop, `--aspect 1:1`, and `--size 2K`. Ask for the complete empty item centered on a perfectly uniform chroma background with generous padding and no shadow. State the exact source-supported construction and all uncertain details that must be omitted.

Default to `#00ff00`; use `#ff00ff` for green garments unless magenta is prominent. Otherwise choose a maximally distant saturated RGB key. Never use a key color present in the garment.

Save generated chroma images to `$WORK/chroma/SLUG.png`. Compare every result against its source before accepting it.

### 5. Remove the chroma background

Use the same key you asked for in the prompt:

```bash
bun run image:remove-background -- --input "$WORK/chroma/SLUG.png" --out "$WORK/items/SLUG.png" --key "#00ff00"
```

The output reports `contaminatedPixels`; anything above a handful means a visible halo. Raise `--tolerance` (up to 110) to remove more background or lower it (down to 18) to keep more edge detail. If removal still damages the item, regenerate with a more distant key instead of forcing the matte.

### 6. Verify

For every final PNG, verify:

- PNG format with an RGBA alpha channel
- transparent corners and border
- visible content with padding and no clipped extremity
- no body part, underlayer, adjacent garment, prop, shadow, or chroma halo
- source-faithful category, proportions, color, material, construction, pattern, and marks
- exactly one output for every accepted manifest record

Inspect checkerboard contact sheets of at most 12 items and compare sensitive results individually with their source crops. Regenerate critical or major failures. Mark only passing records `accepted`.

### 7. Generate modeled photos

Use `$WORK/library/model-reference.png` (from `library:pull`) as the identity reference, or the local photo the user supplied. Never add that photo to Git.

For every accepted cutout, run `bun run image:generate` with the identity image first, the exact garment PNG second, and `--aspect 3:2 --size 2K`. Save the result as `$WORK/modeled/SLUG.png` and set `modeledFile` to `SLUG.png` in the manifest.

Use this generation brief:

```text
Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact clothing item from Image 2.

Preserve the person's recognizable face, hair, age, build, skin texture, and body proportions. Preserve the featured garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, closure, and distinctive details. Do not redesign, simplify, replace, or reinterpret it.

Use understated neutral supporting clothes that complete the outfit without covering or competing with the featured item. Keep the full featured item and every important detail visible. Use a natural pose with arms and accessories away from it.

Place the person in a tasteful real-world setting with warm professional natural light, realistic shadows, authentic skin and fabric texture, and restrained editorial color grading. Leave environmental breathing room for flexible cropping.

Avoid hidden garment details, invented closures, fake text or logos, extra statement pieces, crossed arms, bags or scarves covering the item, cropped item extremities, extra people, text overlays, watermarks, product-mockup styling, or synthetic AI polish.
```

Vary understated settings across a batch while keeping the identity and art direction cohesive. Compare each photo against both references. Regenerate identity drift, garment redesign, blocked details, anatomy failures, or incorrect framing.

### 8. Import into Wardrobe

Show the user the accepted item count and names before writing when their original request did not explicitly authorize direct import. When direct import was requested, proceed after QA.

Run the bundled deterministic importer from the repository root:

```bash
bun run library:import -- \
  --items "$WORK/items" \
  --modeled "$WORK/modeled" \
  --manifest "$WORK/manifest.json"
```

The script validates the cutouts and modeled PNGs and uploads each accepted item to the wardrobe API. Add `--dry-run` to validate without uploading. It derives stable UUIDs from cutout content, so rerunning an identical import updates metadata and modeled photos without creating duplicates.

Verify the new item count with `bun run library:pull -- --out "$WORK/check"` and ask the user to look at the gallery in the app.

For cutout-only delivery, create the requested new child folder under the repository root and copy only accepted PNGs into it. Do not import anything.

## Finish

Return the imported count, skipped/held items, absolute database path, and gallery verification result. Display up to 12 final cutouts in chat. Mention any unrecoverable fragments briefly.
