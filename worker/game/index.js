/*
 * Game bootstrap.
 *
 * The original server relied on Node's non-strict CommonJS "global leakage"
 * (e.g. `Types = {...}`, `module.exports = Player = ...`) so that modules could
 * reference each other's classes as bare globals. Under the Workers bundler
 * (strict ESM) that leakage does not happen, so we:
 *   1. register the shared singletons + classes on `globalThis` explicitly, and
 *   2. require the class hierarchy in dependency order (each class file also
 *      self-registers on globalThis at eval time).
 *
 * `createGame(mapJSON, hooks)` builds a single authoritative world and returns
 * the pieces the Durable Object needs to drive it.
 */

var globalsReady = false;

function setupGlobals() {
    if (globalsReady) {
        return;
    }
    globalThis.log = require("./log");
    globalThis._ = require("underscore");
    globalThis.Class = require("./lib/class").Class;
    globalThis.Types = require("./gametypes");
    globalThis.Utils = require("./utils");
    globalThis.Formulas = require("./formulas");
    globalThis.Properties = require("./properties");
    globalThis.Messages = require("./message");

    // Class hierarchy (each module assigns itself to globalThis.<Name>).
    require("./entity");
    require("./character");
    require("./mob");
    require("./item");
    require("./chest");
    require("./npc");
    require("./area");
    require("./mobarea");
    require("./chestarea");
    require("./checkpoint");
    require("./format");   // -> globalThis.FormatChecker
    require("./player");   // -> globalThis.Player

    globalsReady = true;
}

/**
 * @param {object} mapJSON  Parsed server map (server/maps/world_server.json).
 * @param {object} [hooks]  Optional persistence hooks: { loadPlayer(name) }.
 */
function createGame(mapJSON, hooks) {
    setupGlobals();

    var World = require("./worldserver");
    var Player = require("./player");
    var transport = require("./transport");
    var Server = transport.Server;
    var Connection = transport.Connection;

    var server = new Server();
    var world = new World("world1", 200, server);
    world.run(mapJSON);

    server.onError(function () {
        log.error(Array.prototype.join.call(arguments, ", "));
    });

    server.onConnect(function (connection) {
        var player = new Player(connection, world);

        // Register the default lifecycle callbacks (position request, etc.).
        world.connect_callback(player);

        // Override position resolution to consult durable storage first,
        // so a returning player (same name) spawns where they left off.
        if (hooks && typeof hooks.loadPlayer === "function") {
            player.onRequestPosition(function () {
                var saved = hooks.loadPlayer(player.name);
                if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
                    && world.isValidPosition(saved.x, saved.y)) {
                    return { x: saved.x, y: saved.y };
                }
                if (player.lastCheckpoint) {
                    return player.lastCheckpoint.getRandomPosition();
                }
                return world.map.getRandomStartingPosition();
            });
        }
    });

    return {
        world: world,
        server: server,
        Connection: Connection
    };
}

module.exports = { createGame: createGame };
