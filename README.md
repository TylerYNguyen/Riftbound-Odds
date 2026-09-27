# Riftbound Live Odds

Live top-cut odds for Riftbound TCG tournaments.

**[rb-odds.vercel.app](https://rb-odds.vercel.app)** · [Try the demo event](https://rb-odds.vercel.app/?event=demo) · [Swiss planner](https://rb-odds.vercel.app/planner.html)

Paste an event link from the official Riftbound event locator (for example
`https://locator.riftbound.uvsgames.com/events/683264`), or just the event number. The site pulls the
current standings and pairings, plays out every result still to come, and shows each player's chance of
making the top cut. Players are ranked the same way the event locator does: points, then opponents' match
win %, then game win %, then opponents' game win % (checked against the locator's official standings).

## Features

- Top-cut odds for every player, plus where they're likely to finish
- "If win / If draw / If lose" odds for each player's next match
- "What you need": every path through the remaining rounds, with the odds for each
- Two-day events: Day 2 odds, plus a Day 2 view with its own standings
- Follow yourself or a group of friends, and share a link that opens straight to them
- Rewind to see the odds as they stood at any earlier round
- Top cut bracket with each player's odds to reach every round
- Auto-refresh during live events
- Works on phones and desktop, in light and dark mode

**Swiss planner** (`/planner.html`): how many players end on each record, the "what do I need" mode, and
Day 2 threshold odds, all for a hypothetical event.

## How it works

- **Data:** two Vercel serverless functions (`api/event.js`, `api/round.js`) read the event locator's feed
  and send the page a trimmed version, one round at a time.
- **Odds:** the page plays out the rest of the event many times (`src/lib/live.js`), pairing players by
  points with no rematches, and handling byes, drops and the Day 2 cut. When only the current round's
  matches are left, it checks every possible outcome exactly. The work runs in background Web Workers so
  large events stay responsive.
- **Built with:** React, Vite, Web Workers and Vercel serverless functions.

## Data feed

```
https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2/events/{eventId}/
https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2/tournament-rounds/{roundId}/matches/paginated/?page=1&page_size=100
```

This is the same feed the event locator website reads from. It's public but not officially documented, so
it could change. To keep the load on it low, Vercel's CDN caches the event and the round in play for
20 seconds and finished rounds for an hour, so a room full of players refreshing at once doesn't hammer it.

## Legal

Unofficial fan project, not affiliated with Riot Games or UVS Games.

Riftbound Live Odds was created under Riot Games' "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.
