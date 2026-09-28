const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_MESSAGES = 100;
const roomMessages = new Map();
const seeds = {
  "indiranagar:local": [
    ["Maya", "Does anyone know why 12th Main is blocked?"],
    ["Arjun", "A tree came down near the signal. Traffic is moving on 13th Main."],
    ["Nila", "Power is back on near the park 🎉"]
  ],
  "indiranagar:open": [
    ["Theo", "Visiting this weekend—best place for a quiet breakfast?"],
    ["Rhea", "Try the smaller cafés around 12th Main before 9."]
  ]
};

function history(key) {
  if (!roomMessages.has(key)) {
    roomMessages.set(key, (seeds[key] || []).map(([name, text], index) => ({
      id: `seed-${key}-${index}`, name, text,
      createdAt: Date.now() - (3 - index) * 120000
    })));
  }
  return roomMessages.get(key);
}
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end("Forbidden");
  fs.readFile(file, (error, data) => {
    if (error) return res.writeHead(404).end("Not found");
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(data);
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
      ws.profile = {
        name: String(event.profile?.name || "Neighbour").slice(0, 30),
        homeRoom: String(event.profile?.homeRoom || "")
      };
      return send(ws, { type: "history", messages: history(ws.roomKey).slice(-MAX_MESSAGES) });
    }

    if (event.type === "message" && ws.roomKey) {
      const [roomId, channel] = ws.roomKey.split(":");
      if (channel === "local" && ws.profile?.homeRoom !== roomId) {
        return send(ws, { type: "error", message: "Only verified locals can post in this channel." });
      }
      const text = String(event.text || "").trim().slice(0, 500);
      if (!text) return;
      const message = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: ws.profile.name, text, createdAt: Date.now() };
      const messages = history(ws.roomKey);
      messages.push(message);
      if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
      for (const client of wss.clients) if (client.roomKey === ws.roomKey) send(client, { type: "message", message });
    }
  });
});

server.listen(PORT, () => console.log(`Nearby is running at http://localhost:${PORT}`));
