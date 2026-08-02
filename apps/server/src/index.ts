import http from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { MatchRoom } from "./rooms/MatchRoom";

const port = Number(process.env.SERVER_PORT ?? 2567);

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

/**
 * No options: a room builds The Curiosity Shop's object registry and its own
 * spatial bridge itself (see MatchRoom.onCreate). That is deliberate rather
 * than lazy. Geometry used to be something this file had to remember to pass,
 * and because it never did, the dedicated server spent its whole life on a
 * permissive validator: accusations unchecked for range, direct-look escapes
 * unchecked for line of sight, creep destinations unchecked against the walls.
 * A default that has to be opted out of cannot be forgotten.
 */
gameServer.define("match", MatchRoom);

httpServer.listen(port, () => {
  console.log(`[foldseek-server] listening on :${port}`);
});
