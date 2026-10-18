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

```bash
git clone https://github.com/tika/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ Importing stays disabled until you add `GEMINI_API_KEY` to `.env` ([get a key](https://aistudio.google.com/apikey)) and place a PNG reference photo of yourself at `data/model-reference.png`.

Open [localhost:5173](http://localhost:5173).

### iOS

Keep `npm run dev` running, then in a second terminal:

```bash
npm run ios
```

This opens the app in the iOS Simulator through Expo. On a phone, scan the QR code with the Camera app (Expo Go must be installed) while the phone is on the same Wi-Fi network. The app finds the Wardrobe server on the computer running Expo; set `EXPO_PUBLIC_API_URL` to point it somewhere else.

## Import with an agent

This repo includes two agent skills, for [Claude Code](https://claude.com/claude-code) (`.claude/skills`) and Codex (`.agents/skills`). One imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
/import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
/generate-outfits Create modeled outfit ideas from my wardrobe.
```

In Codex, use `$import-clothes` and `$generate-outfits` instead. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

Both skills generate images with Gemini through these commands, which you can also run yourself:

| Command | What it does |
| --- | --- |
| `npm run image:generate` | Generate an image from a prompt file and reference images |
| `npm run image:remove-background` | Make a chroma-key background transparent |
| `npm run library:import` | Add reviewed cutouts and modeled photos to the wardrobe |

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Agent:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **App:** Help the user configure their own `GEMINI_API_KEY` and `data/model-reference.png`, then let them import through the web or iOS app.

## What it does

- Detects every garment in a photo with Gemini
- Extracts clean product cutouts with Nano Banana Pro
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval on the web, and photo library or camera import on iOS

## Project layout

| Path | Contents |
| --- | --- |
| `apps/server` | API server (Hono), Gemini calls, image processing, agent CLIs |
| `apps/web` | Web app (React + Vite) |
| `apps/mobile` | iOS app (Expo + Expo Router) |
| `packages/core` | Types, status helpers, and the API client shared by both apps |

`npm run build` builds the web app; `npm start` then serves the site and API together on port 4747.

## Configuration

| Variable | Default |
| --- | --- |
| `GEMINI_API_KEY` | Required |
| `GEMINI_IMAGE_MODEL` | `gemini-3-pro-image` (Nano Banana Pro) |
| `GEMINI_VISION_MODEL` | `gemini-3.8-flash` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |
| `PORT` | `4747` |

## License

[MIT](LICENSE)
