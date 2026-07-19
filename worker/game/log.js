/*
 * Minimal logger replacing the Node `log` package used by the original server.
 * The original code calls a global `log.info/debug/error`; the game bootstrap
 * (game/index.js) assigns an instance of this to `globalThis.log`.
 *
 * LEVEL can be tuned; DEBUG is very chatty (per-message), so default to INFO.
 */
var LEVELS = { error: 0, info: 1, debug: 2 };
var current = LEVELS.info;

var log = {
    setLevel: function (name) {
        if (name in LEVELS) current = LEVELS[name];
    },
    error: function () {
        if (current >= LEVELS.error) console.error.apply(console, arguments);
    },
    info: function () {
        if (current >= LEVELS.info) console.log.apply(console, arguments);
    },
    debug: function () {
        if (current >= LEVELS.debug) console.log.apply(console, arguments);
    }
};

module.exports = log;
