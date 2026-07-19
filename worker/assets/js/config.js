
// No external config file needed: served from the Cloudflare Worker, the
// client connects back to the same origin (gameclient.js builds the ws/wss
// URL with the "/ws" path). The port is empty on standard 80/443.
define([], function() {
    var loc = window.location,
        host = loc.hostname,
        port = loc.port;

    var origin = { host: host, port: port, dispatcher: false };

    return {
        dev: origin,
        build: origin
    };
});