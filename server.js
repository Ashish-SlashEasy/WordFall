/* ============================================================
   Word Fall — multiplayer relay + leaderboard server

   Zero dependencies: Node built-ins only (http, fs, path, os).
   Run with:  node server.js  [port]     (default port 3000)

   Responsibilities:
   - Serve the game's static files (index.html, script.js, ...)
   - 2-player rooms with 4-letter codes; relay JSON messages
     between the two players (Server-Sent Events for pushes,
     POST /send for client -> server messages)
   - Persistent global leaderboard in leaderboard.json

   All gameplay runs client-side; the server never simulates.
   ============================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Hosting platforms (Render, Railway, etc.) assign the port via env var;
// a CLI arg still works for local runs, e.g. `node server.js 3001`.
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 3000;
const ROOT = __dirname;
const LEADERBOARD_FILE = path.join(ROOT, "leaderboard.json");
const LEADERBOARD_CAP = 100;
const ROOM_TTL_MS = 10 * 60 * 1000; // stale rooms expire after 10 min

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/* ------------------------------------------------------------
   Leaderboard: load on start, debounced save on change
   ------------------------------------------------------------ */
let leaderboard = [];
try {
  leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8"));
  if (!Array.isArray(leaderboard)) leaderboard = [];
} catch {
  leaderboard = [];
}

let saveTimer = null;
function saveLeaderboard() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2), (err) => {
      if (err) console.error("leaderboard save failed:", err.message);
    });
  }, 250);
}

/** Record a finished run; keeps the list sorted by score, capped. */
function recordScore({ name, score, wpm, accuracy, mode }) {
  const entry = {
    name: String(name || "anon").slice(0, 16),
    score: Math.max(0, Number(score) || 0),
    wpm: Math.max(0, Number(wpm) || 0),
    accuracy: Math.max(0, Math.min(100, Number(accuracy) || 0)),
    mode: mode === "1v1" ? "1v1" : "solo",
    date: new Date().toISOString().slice(0, 10),
  };
  leaderboard.push(entry);
  leaderboard.sort((a, b) => b.score - a.score);
  leaderboard = leaderboard.slice(0, LEADERBOARD_CAP);
  saveLeaderboard();
  // Rank of this entry among all (1-based); -1 if it fell off the cap
  const rank = leaderboard.indexOf(entry);
  return rank === -1 ? -1 : rank + 1;
}

/* ------------------------------------------------------------
   Rooms
   ------------------------------------------------------------ */
// code -> { players: [{id, name, res|null, stats|null}], started, dead: Set, touched }
const rooms = new Map();

function makeRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

/** Push one SSE message to a single player (no-op if not connected). */
function push(player, type, data) {
  if (!player || !player.res) return;
  player.res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

function opponentOf(room, playerId) {
  return room.players.find((p) => p.id !== playerId);
}

function touch(room) {
  room.touched = Date.now();
}

/** Both players present: hand out the shared seed and start the match. */
function startMatch(room) {
  room.started = true;
  const seed = Math.floor(Math.random() * 2 ** 31);
  for (const p of room.players) {
    push(p, "start", { seed, opponentName: opponentOf(room, p.id).name });
  }
}

/** A player died (or forfeited): the other one wins; tell both. */
function finishMatch(room, loserId, reason) {
  if (room.finished) return;
  room.finished = true;
  const winner = opponentOf(room, loserId);
  const loser = room.players.find((p) => p.id === loserId);

  // Record both players' final runs on the leaderboard
  for (const p of room.players) {
    if (p.stats) recordScore({ ...p.stats, name: p.name, mode: "1v1" });
  }

  for (const p of room.players) {
    push(p, "gameover", {
      winnerId: winner ? winner.id : null,
      reason,
      stats: room.players.map((q) => ({ id: q.id, name: q.name, stats: q.stats })),
    });
  }
  void loser;
}

// Periodic cleanup of stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_TTL_MS) {
      for (const p of room.players) if (p.res) p.res.end();
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

/* ------------------------------------------------------------
   Client -> server messages (POST /send)
   ------------------------------------------------------------ */
function handleMessage(msg, respond) {
  const type = msg.type;

  if (type === "create") {
    const code = makeRoomCode();
    const player = { id: "p1", name: String(msg.name || "Player 1").slice(0, 16), res: null, stats: null };
    rooms.set(code, { players: [player], started: false, finished: false, touched: Date.now() });
    return respond(200, { room: code, playerId: "p1" });
  }

  const room = rooms.get(String(msg.room || "").toUpperCase());
  if (!room) return respond(404, { error: "Room not found" });
  touch(room);

  if (type === "join") {
    if (room.players.length >= 2) return respond(409, { error: "Room is full" });
    if (room.finished) return respond(409, { error: "Match already over" });
    room.players.push({ id: "p2", name: String(msg.name || "Player 2").slice(0, 16), res: null, stats: null });
    return respond(200, { playerId: "p2" });
    // Match starts once p2's SSE connection is up (see /events)
  }

  const player = room.players.find((p) => p.id === msg.playerId);
  if (!player) return respond(403, { error: "Unknown player" });

  if (type === "state") {
    // Keep last known stats for the leaderboard, relay to the opponent
    player.stats = msg.stats;
    push(opponentOf(room, player.id), "opponent-state", { stats: msg.stats });
    return respond(200, { ok: true });
  }

  if (type === "death") {
    player.stats = msg.stats;
    finishMatch(room, player.id, "death");
    return respond(200, { ok: true });
  }

  return respond(400, { error: "Unknown message type" });
}

/* ------------------------------------------------------------
   HTTP server
   ------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // ---- SSE stream: server -> client pushes ----
  if (req.method === "GET" && url.pathname === "/events") {
    const room = rooms.get((url.searchParams.get("room") || "").toUpperCase());
    const player = room && room.players.find((p) => p.id === url.searchParams.get("player"));
    if (!room || !player) {
      res.writeHead(404);
      return res.end();
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    player.res = res;
    touch(room);

    // Keep proxies from killing the idle stream
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);

    // Both players connected -> start the match
    if (!room.started && room.players.length === 2 && room.players.every((p) => p.res)) {
      startMatch(room);
    }

    req.on("close", () => {
      clearInterval(ping);
      player.res = null;
      // Dropping mid-match forfeits the game
      if (room.started && !room.finished) {
        finishMatch(room, player.id, "forfeit");
      }
      // Delete the room once everyone is gone
      if (room.players.every((p) => !p.res)) {
        rooms.delete((url.searchParams.get("room") || "").toUpperCase());
      }
    });
    return;
  }

  // ---- Leaderboard ----
  if (req.method === "GET" && url.pathname === "/leaderboard") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(leaderboard.slice(0, 10)));
  }

  // ---- JSON POST endpoints ----
  if (req.method === "POST" && (url.pathname === "/send" || url.pathname === "/score")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) req.destroy(); // sanity cap
    });
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Bad JSON" }));
      }
      const respond = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/score") {
        const rank = recordScore({ ...msg, mode: "solo" });
        return respond(200, { rank });
      }
      handleMessage(msg, respond);
    });
    return;
  }

  // ---- Static files ----
  if (req.method === "GET") {
    let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    file = path.normalize(file);
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || file === "leaderboard.json" || file === "server.js") {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Word Fall server running:`);
  console.log(`  You:            http://localhost:${PORT}`);
  // Print LAN addresses so the second player knows where to connect
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) {
        console.log(`  Your opponent:  http://${a.address}:${PORT}`);
      }
    }
  }
});
