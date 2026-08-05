/*
 * Portals server-script probe (2026-08-06).
 *
 * It answers one question that the documentation does not: when Portals
 * serves this game from an imported GitHub repository, does it run a
 * `server.js` found in the served bundle (portals/) or in the REPOSITORY ROOT (this
 * file)? A twin of this file sits in portals/ writing a
 * different key, so whichever keys appear names the location that ran.
 *
 * It deliberately does nothing else. `server.js` ships publicly with the
 * bundle, so it carries no secret and no game logic.
 *
 * Plain ES5-flavoured JavaScript on purpose: the sandbox takes one script
 * with no imports, and this file must not depend on the client toolchain.
 */
var PROBE_WHERE = "repo-root";
var PROBE_KEY = "server:probe_root";

function probeStamp(note) {
  try {
    var roster = server.players();
    server.setState(PROBE_KEY, {
      where: PROBE_WHERE,
      note: note,
      players: roster && typeof roster.length === "number" ? roster.length : -1,
    });
  } catch (error) {
    server.log("foldseek probe: setState failed", String(error));
  }
}

try {
  server.log("foldseek server probe alive:", PROBE_WHERE);
  probeStamp("boot");

  server.on("playerjoin", function (player, players) {
    server.log(
      "foldseek probe: join",
      player && player.id,
      players && players.length,
    );
    probeStamp("join");
  });

  server.on("message", function (data, fromId) {
    // Only answers its own probe shape, so it can never disturb the game's
    // own traffic if this file outlives the experiment.
    if (data && data.t === "foldseek_probe") {
      server.send({ t: "foldseek_probe_ack", where: PROBE_WHERE, from: fromId });
      probeStamp("ack");
    }
  });
} catch (error) {
  server.log("foldseek probe: boot failed", String(error));
}
