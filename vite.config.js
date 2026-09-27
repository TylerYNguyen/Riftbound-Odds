import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import eventHandler from "./api/event.js";
import roundHandler from "./api/round.js";

// In local dev (npm run dev), answer /api/event and /api/round with the same code the Vercel
// functions run, so you don't need the Vercel CLI to try things out.
function localApi() {
  // Vercel gives functions req.query, res.status() and res.json(); add the same helpers here.
  const run = (handler) => async (req, res) => {
    req.query = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
    try {
      await handler(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) { res.statusCode = 500; res.end(); }
    }
  };
  return {
    name: "local-api",
    configureServer(server) {
      server.middlewares.use("/api/event", run(eventHandler));
      server.middlewares.use("/api/round", run(roundHandler));
      // Any other /api/ address: a JSON 404 (otherwise Vite answers with the site's own page).
      server.middlewares.use("/api", (req, res) => {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "This site's server doesn't know that address. Reload the page and try again.", code: "NOT_FOUND" }));
      });
    },
  };
}

export default defineConfig({ plugins: [react(), localApi()] });
