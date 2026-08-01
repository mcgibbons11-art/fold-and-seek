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
gameServer.define("match", MatchRoom);

httpServer.listen(port, () => {
  console.log(`[foldseek-server] listening on :${port}`);
});
