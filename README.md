<div align="center">

# Wardrobe

Your clothes, extracted and organized with Gemini, on the web and iOS.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22.18%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485) · Forked from [tandpfun/wardrobe](https://github.com/tandpfun/wardrobe)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

Wardrobe runs as a Cloudflare Worker (API, database, image storage, and the web app) behind Cloudflare Access, plus an iOS app. You need [Bun](https://bun.sh), a Cloudflare account, and a [Gemini API key](https://aistudio.google.com/apikey).

```bash
git clone https://github.com/tika/wardrobe.git
cd wardrobe
bun install
cp .env.example .env   # add GEMINI_API_KEY and WARDROBE_OWNER_EMAIL
bun run dev
```

Open [localhost:5173](http://localhost:5173). `bun run dev` runs the Worker locally on port 4747 (local D1, R2, and workflows) next to the web app, signed in as `WARDROBE_OWNER_EMAIL`. The first time you import, the app asks for a clear photo of yourself; it is used to show your clothes on you.

### Deploy

```bash
bun run deploy
```

Alchemy creates the D1 database, R2 bucket, workflow, Worker, and a Cloudflare Access application. Only `WARDROBE_OWNER_EMAIL` can sign in (Access emails a one-time code), plus a service token for the iOS app and the agent tools. The deploy prints that token; copy it into `.env` as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`.

Pushes to `main` deploy the `prod` stage at `wardrobe.capon.io` through GitHub Actions. The repository needs the secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY`, and `WARDROBE_OWNER_EMAIL`.

### iOS

```bash
cp apps/mobile/.env.example apps/mobile/.env   # add the service token
bun run ios
```

This opens the app in the iOS Simulator through Expo; on a phone, scan the QR code with the Camera app (Expo Go must be installed). In development the app uses the local Worker from `bun run dev`; otherwise it uses `wardrobe.capon.io`. Set `EXPO_PUBLIC_API_URL` to point it elsewhere.

## Import with an agent

This repo includes two agent skills, for [Claude Code](https://claude.com/claude-code) (`.claude/skills`) and Codex (`.agents/skills`). One imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
/import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
/generate-outfits Create modeled outfit ideas from my wardrobe.
```

In Codex, use `$import-clothes` and `$generate-outfits` instead. The import skill uses the reference photo you uploaded in the app, reviews every cutout and modeled photo, then adds the pieces to your wardrobe. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

Both skills generate images with Gemini through these commands, which you can also run yourself:

| Command | What it does |
| --- | --- |
| `bun run image:generate` | Generate an image from a prompt file and reference images |
| `bun run image:remove-background` | Make a chroma-key background transparent |
| `bun run library:pull` | Download the wardrobe and your reference photo to a local folder |
| `bun run library:import` | Add reviewed cutouts and modeled photos to the wardrobe |

The library commands talk to the deployed app with the service token from `.env` (or `WARDROBE_API_URL`).

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Agent:** Ask for a folder or camera-roll location, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **App:** Help the user configure `.env` and deploy (see [Deploy](#deploy)), then let them import through the web or iOS app.

## What it does

- Detects every garment in a photo with Gemini
- Extracts clean product cutouts with Nano Banana Pro
- Generates an optional modeled editorial preview
- Stores everything in your own Cloudflare account (D1 and R2), behind Cloudflare Access
- Supports drag, drop, paste, editing, review, regeneration, and approval on the web, and photo library or camera import on iOS

## Project layout

| Path | Contents |
| --- | --- |
| `apps/backend` | Cloudflare Worker (Hono, Drizzle on D1, R2, Workflows), Gemini calls, image processing, agent CLIs, Alchemy stack |
| `apps/web` | Web app (React + Vite), served by the Worker |
| `apps/mobile` | iOS app (Expo + Expo Router) |
| `packages/core` | Types, status helpers, and the API client shared by both apps |

`bun run check` typechecks everything, runs the backend tests, and builds the web app. After changing `apps/backend/src/db/schema.ts`, run `bun run --filter @wardrobe/backend db:generate` and commit the new migration.

## Configuration

| Variable | Default |
| --- | --- |
| `GEMINI_API_KEY` | Required |
| `WARDROBE_OWNER_EMAIL` | Required: the one email Access lets in |
| `GEMINI_IMAGE_MODEL` | `gemini-3-pro-image` (Nano Banana Pro) |
| `GEMINI_VISION_MODEL` | `gemini-3.8-flash` |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Service token for the CLIs (printed by `bun run deploy`) |
| `WARDROBE_API_URL` | `https://wardrobe.capon.io` (CLIs only) |

## License

[MIT](LICENSE)
