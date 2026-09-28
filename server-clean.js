const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3100;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_MESSAGES = 100;
const roomMessages = new Map();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") {
    return fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8", (error, html) => {
      if (error) return res.writeHead(404).end("Not found");
      const cleanHtml = html
        .replace('<link rel="stylesheet" href="/styles.css" />', '<link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/theme-clean.css" />')
        .replace('<script src="/app.js"></script>', '<script src="/app-clean.js"></script>');
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(cleanHtml);
    });
  }

  const relative = urlPath.replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end("Forbidden");
  fs.readFile(file, (error, data) => {
    if (error) return res.writeHead(404).end("Not found");
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: "error", message: "That message could not be read." }); }

    if (event.type === "join") {
      const roomId = String(event.roomId || "").slice(0, 60);
      const channel = event.channel === "local" ? "local" : "open";
      ws.roomKey = `${roomId}:${channel}`;
      ws.profile = { name: String(event.profile?.name || "Neighbour").slice(0, 30), homeRoom: String(event.profile?.homeRoom || "") };
      return send(ws, { type: "history", messages: (roomMessages.get(ws.roomKey) || []).slice(-MAX_MESSAGES) });
    }

    if (event.type === "message" && ws.roomKey) {
      const [roomId, channel] = ws.roomKey.split(":");
      if (channel === "local" && ws.profile?.homeRoom !== roomId) return send(ws, { type: "error", message: "Only locals can post in this channel." });
      const text = String(event.text || "").trim().slice(0, 500);
      if (!text) return;
      const message = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: ws.profile.name, text, createdAt: Date.now() };
      const messages = roomMessages.get(ws.roomKey) || [];
      messages.push(message);
      roomMessages.set(ws.roomKey, messages.slice(-MAX_MESSAGES));
      for (const client of wss.clients) if (client.roomKey === ws.roomKey) send(client, { type: "message", message });
    }
  });
});

server.listen(PORT, () => console.log(`Nearby clean build is running at http://localhost:${PORT}`));
