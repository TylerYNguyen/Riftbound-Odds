# Riftbound Calculator Site

Live top-cut odds for Riftbound events. Paste an event locator link
(e.g. `https://locator.riftbound.uvsgames.com/events/512931`) and the site pulls
current standings and pairings. It then plays out every result still to come
and ranks players the same way the event locator does: points, then opponents' match win %,
then game win %, then opponents' game win % (checked against the locator's official standings).

Also includes the **Swiss planner** (`/planner.html`). It shows how many players end on each
record, the "what do I need" mode, and Day 2 threshold odds, all for a hypothetical event.

## Run it on your computer

Requires Node.js 18 or newer.

```bash
cd D:\Claude\riftbound-calculator-site
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173). Try `demo` in the box, or paste a real
event link. The dev server answers `/api/event` and `/api/round` itself (running the same code as
the Vercel functions), so real events work locally too.

## Deploy to Vercel

1. Create a new GitHub repo named `riftbound-calculator-site` and push this folder:
   ```bash
   git init
   git add .
   git commit -m "Riftbound calculator site"
   git branch -M main
   git remote add origin https://github.com/TylerYNguyen/riftbound-calculator-site.git
   git push -u origin main
   ```
2. In Vercel, choose **Add New → Project** and import that repo. It detects Vite on its own, with no settings to change.
3. Deploy. The files in `api/` become the server functions `/api/event` and `/api/round`.

## How the pieces fit

| Path | What it does |
| --- | --- |
| `api/event.js` | Vercel server function: `GET /api/event?id=512931`, the event and its round list (cached 20 s) |
| `api/round.js` | Vercel server function: `GET /api/round?id=<roundId>`, one round's matches. Finished rounds are cached for an hour on Vercel's CDN; the round being played for 20 s |
| `server/loadEvent.js` | Reads the locator's public data feed (at most 4 pages of a round at once) and trims it to a small shape |
| `server/respond.js` | Cache rules and error replies shared by the functions |
| `src/lib/fetchEvent.js` | The page's loader: event info, then each round (2 at a time), reusing finished rounds on refresh |
| `src/lib/live.js` | The odds engine: rebuilds standings and tiebreakers, then checks every combination (when only this round's unfinished matches are left) or simulates (when rounds remain). `planRuns()` sets the accuracy targets: ±3% early, ±1% late, 40,000 runs for 128 players or fewer |
| `src/lib/runner.js` | Splits the simulation across background workers (one per spare CPU core), streams results in, stops at the target or 30 seconds |
| `src/lib/oddsWorker.js` | The background worker itself |
| `src/App.jsx` | The page: load an event, settings, "follow a player" card, standings table |
| `src/demo.json` | Invented sample event for trying it without a live tournament |
| `public/planner.html` | The standalone Swiss planner |
| `public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | Tab icon and phone home-screen icon |

### Data feed used

```
https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2/events/{eventId}/
https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2/tournament-rounds/{roundId}/matches/paginated/?page=1&page_size=100
```

This is the same feed the locator website reads from. It's public but not officially documented,
so it could change. If imports break, check the Network tab on the locator site for the new
addresses. Vercel's CDN caches the event and the round in play for 20 seconds and finished rounds
for an hour, so a room full of players doesn't hammer it.

Unofficial fan tool, not affiliated with Riot Games or UVS Games.
