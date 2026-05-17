# Mathgod

A calm, minimal multiplication practice app for iPhone Safari.
Vanilla HTML / CSS / JS. Installable as a PWA. Works fully offline.

## Modes

- **1 × 1** — single-digit, factors `2 – 9 × 2 – 9`
- **1 × 2** — mixed, factors `2 – 9 × 10 – 20`
- **2 × 2** — double-digit, factors `10 – 20 × 10 – 20`

Each session is 10 questions. Questions you get wrong reappear more often
(adaptive weighting per `(a, b)` pair stored in `localStorage`).

## Run locally

The app is plain static files — any local web server works. From the repo root:

```sh
# Python 3
python3 -m http.server 8080
# then open http://localhost:8080
```

> Service workers require `http://` (or `https://`), not `file://`.
> The app still runs from `file://` for quick previews, just without offline caching.

## Deploy to GitHub Pages

1. Push the contents of this repo (top-level files) to your repository.
2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**:
   - **Source:** *Deploy from a branch*
   - **Branch:** the branch you want (e.g. `main`) and folder `/ (root)`
4. Save. After a minute the site will be live at:
   `https://<your-username>.github.io/<repo-name>/`

All asset paths in this project are relative (`./style.css`, `./app.js`,
`./icons/...`, `./service-worker.js`, `./manifest.json`), so the app works
regardless of which sub-path Pages serves it from.

## Install on iPhone (Add to Home Screen)

1. Open the deployed URL in **Safari** on iPhone.
2. Tap the **Share** icon (square with the arrow).
3. Tap **Add to Home Screen**.
4. Tap **Add**.

Launching from the home-screen icon opens Mathgod full-screen, with the
iOS status bar styled to match. After your first online launch the service
worker caches the shell, so it works fully offline thereafter.

## Project layout

```
.
├── index.html          # markup for all views
├── style.css           # design tokens, layout, animations
├── app.js              # game loop, mastery weighting, theming
├── manifest.json       # PWA manifest
├── service-worker.js   # offline caching
├── icons/              # PNG + SVG icons (regenerable via _generate.py)
└── README.md
```

### Regenerating icons

Icons are committed PNGs so the repo works out of the box. To rebuild
them (e.g. after a brand tweak), run:

```sh
pip install Pillow
python3 icons/_generate.py
```

## Tech notes

- **Adaptive selection.** `pickQuestion()` in `app.js` weights each pair by
  `(1.25 − accuracy) · noveltyBoost · recencyBoost`, so weak pairs and
  rarely-seen pairs are favoured without ever fully excluding the rest.
- **Persistence.** All progress lives under the `mathgod:v1` key in
  `localStorage`. Clearing site data resets stats.
- **Theme.** Auto-follows the system, or can be cycled (auto → light → dark)
  from the sun/moon button on the home screen.
- **Offline.** Network-first for navigations (so updates land quickly when
  online) with a cache fallback; cache-first for static assets.
- **Cache busting.** Bump `CACHE_VERSION` in `service-worker.js` when
  shipping changes so clients pick them up on next launch.

## Browser support

Designed for modern iOS Safari (16+) and evergreen Chromium / Firefox.
Uses `dvh` units, `prefers-color-scheme`, `env(safe-area-inset-*)`, and
standard service-worker APIs.
