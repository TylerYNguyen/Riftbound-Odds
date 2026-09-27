// Shared by the Vercel functions in api/: cache rules and error replies.
import { FeedError } from "./loadEvent.js";

// s-maxage = how long Vercel's CDN keeps a copy; max-age=0 = browsers always ask again (the page keeps
// finished rounds itself, see src/lib/fetchEvent.js).
// Event info: briefly, so a room full of players shares one locator request.
export const EVENT_CACHE = "public, max-age=0, s-maxage=20, stale-while-revalidate=40";
// A round still being played (or the newest round): briefly too.
export const LIVE_CACHE = "public, max-age=0, s-maxage=20, stale-while-revalidate=40";
// A finished round: an hour on Vercel's CDN (then refreshed in the background), so a result
// corrected after its round ended shows up within about an hour.
export const DONE_CACHE = "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";

export function badInput(res, message) {
  res.setHeader("Cache-Control", "no-store");
  res.status(400).json({ error: message, code: "BAD_INPUT" });
}

// Every failure → { error, code } with a plain message. Errors are never cached.
export function sendError(res, err, what, id) {
  const feed = err instanceof FeedError;
  if (!feed || err.code === "FEED_CHANGED") console.error(what, id, err.code || "", err.detail || "", err.stack || err);
  res.setHeader("Cache-Control", "no-store");
  res.status(feed ? err.status : 500).json({
    error: feed ? err.message : "Something went wrong on this site's server while loading that event. Try again in a minute.",
    code: feed ? err.code : "SERVER_ERROR",
  });
}
