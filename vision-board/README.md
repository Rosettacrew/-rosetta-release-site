# Rosetta Vision Board

Lightweight digital vision board + planning PWA for **Roger Hester / Rosetta Crew**.

Vanilla HTML/CSS/JS — no build step. Local-first (IndexedDB, with localStorage fallback). Works in the browser and as an iPhone home-screen web app.

## How to open

From this folder:

```bash
cd /workspace/vision-board
python3 -m http.server 8765
```

Then visit: http://localhost:8765/

Or any static server (`npx serve`, etc.). Prefer `http://` over `file://` so the service worker and Notification API can work.

### iOS (Add to Home Screen)

1. Open the site in **Safari**.
2. Tap Share → **Add to Home Screen**.
3. Open from the icon (standalone). Notifications are limited on iOS; permission may only work after install / in supported Safari versions. Due items still show in the Today tab.

## Sections

| Tab | Purpose |
|-----|---------|
| **Today** | Today’s items, due soon (3 days), goals under ~40% progress |
| **Calendar** | Month grid → tap date → add tasks / appointments / deadlines / milestones |
| **Goals** | Create/edit goals with progress bars; manage categories |
| **Todos** | Checklist of calendar/todo items; complete toggles goal progress when linked |
| **Vision** | Text pins (optional image URL); drag to position |

Header: **Reminders** (Notification API), **Export** / **Import** JSON, **Clear samples**.

## Seeded categories

Rosetta Crew OS · Music releases · BeatBay · Games · Personal goals · Other (editable).

First load seeds sample goals, tasks, and pins (marked **sample**). Use **Clear samples** to remove them.

## Data model

Stored in IndexedDB DB `rosetta-vision-board` (or `localStorage` key `rosetta-vision-board-v1`):

- **categories** — `{ id, name, color?, order }`
- **goals** — `{ id, title, description?, categoryId, target, current, unit?, status, sample?, createdAt, updatedAt }`
- **items** — `{ id, title, type: task|appointment|deadline|milestone, date, time?, done, goalId?, categoryId?, notes?, sample?, … }`
- **pins** — `{ id, text, imageUrl?, x, y, color?, sample?, createdAt }`
- **meta** — key/value (`seeded`, `reminderPermissionAsked`, …)

Completing an item linked to a `goalId` increments that goal’s `current` by 1; un-completing decrements.

Export/import dumps or replaces all stores as JSON (`version: 1`).

## Files

```
vision-board/
  index.html
  styles.css
  manifest.webmanifest
  sw.js
  README.md
  icons/icon.svg | icon-192.png | icon-512.png
  js/db.js | seed.js | reminders.js | app.js
```

## Extension points

- New tab: add `main.view`, nav button, and a `render*` branch in `js/app.js`.
- New item types: extend `TYPE_LABELS` and the item form select.
- Sync: replace or wrap `VBDB.exportAll` / `importAll` with a remote push/pull.
- Richer vision: keep pins text/URL-only for storage; avoid blob uploads unless you add quota handling.
- Reminders: `js/reminders.js` polls every 60s; hook `checkDue` or use Push later.

## Limitations

- No cloud sync (JSON backup only).
- Image pins are remote URLs only (not file uploads).
- iOS notifications are unreliable vs desktop Chrome/Firefox.
- Service worker caches the app shell; bump `CACHE` in `sw.js` after deploy changes.
- Single-device local data unless you export/import.

## License

Personal / Rosetta Crew use.
