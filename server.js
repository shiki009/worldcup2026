// Minimal zero-dependency static server for the World Cup 2026 watch planner.
// Serves scores.json directly and falls back to index.html for every other route.
// Railway provides the PORT env var.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// Files served directly; anything else falls back to the app shell (index.html).
const STATIC = {
  "/scores.json": { file: "scores.json", type: "application/json; charset=utf-8", maxAge: 60 }
};
const SHELL = { file: "index.html", type: "text/html; charset=utf-8", maxAge: 300 };

const server = http.createServer((req, res) => {
  const route = req.url.split("?")[0];
  const target = STATIC[route] || SHELL;

  fs.readFile(path.join(__dirname, target.file), (err, data) => {
    if (err) {
      // A missing scores.json just means the cron hasn't run yet — the client
      // tops up live from ESPN, so return an empty payload instead of failing.
      if (target !== SHELL) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"scores":{}}');
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": target.type,
      "Cache-Control": `public, max-age=${target.maxAge}`
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`World Cup 2026 planner listening on :${PORT}`);
});
