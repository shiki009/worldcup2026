// Minimal zero-dependency static server for the World Cup 2026 watch planner.
// Serves index.html for every route; Railway provides the PORT env var.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, "index.html");

const server = http.createServer((req, res) => {
  fs.readFile(FILE, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300"
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`World Cup 2026 planner listening on :${PORT}`);
});
