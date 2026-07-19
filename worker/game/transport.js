/*
 * Replacement for server/js/ws.js.
 *
 * Instead of Node's websocket-server, connections are backed by the Durable
 * Object's (hibernatable) WebSockets. This module only implements the
 * Server/Connection interface that worldserver.js and player.js expect:
 *   Server:     onConnect, addConnection, removeConnection, getConnection,
 *               forEachConnection, broadcast, onError, onRequestStatus
 *   Connection: id, listen(cb), onClose(cb), send(msg), sendUTF8(data), close()
 *
 * Wire format is JSON (matching the client with useBison=false).
 */

function Connection(id, ws, server) {
    this.id = id;
    this._ws = ws;
    this._server = server;
    this.listen_callback = null;
    this.close_callback = null;
}

Connection.prototype.listen = function (callback) {
    this.listen_callback = callback;
};

Connection.prototype.onClose = function (callback) {
    this.close_callback = callback;
};

Connection.prototype.send = function (message) {
    this.sendUTF8(JSON.stringify(message));
};

Connection.prototype.sendUTF8 = function (data) {
    try {
        this._ws.send(data);
    } catch (e) {
        // Socket may already be closed; ignore.
    }
};

Connection.prototype.close = function (reason) {
    try {
        this._ws.close(1000, reason ? String(reason).substring(0, 120) : "");
    } catch (e) {
        // ignore
    }
};

// Called by the Durable Object when a raw message arrives for this socket.
Connection.prototype.receive = function (raw) {
    if (!this.listen_callback) {
        return;
    }
    var parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        this.close("Received message was not valid JSON.");
        return;
    }
    this.listen_callback(parsed);
};


function Server() {
    this._connections = {};
    this.connection_callback = null;
    this.error_callback = null;
    this.status_callback = null;
}

Server.prototype.onConnect = function (callback) {
    this.connection_callback = callback;
};

Server.prototype.onError = function (callback) {
    this.error_callback = callback;
};

Server.prototype.onRequestStatus = function (callback) {
    this.status_callback = callback;
};

Server.prototype.addConnection = function (connection) {
    this._connections[connection.id] = connection;
};

Server.prototype.removeConnection = function (id) {
    delete this._connections[id];
};

Server.prototype.getConnection = function (id) {
    return this._connections[id];
};

Server.prototype.forEachConnection = function (callback) {
    for (var id in this._connections) {
        callback(this._connections[id]);
    }
};

Server.prototype.broadcast = function (message) {
    this.forEachConnection(function (connection) {
        connection.send(message);
    });
};

// Registers a new connection and fires the world's connect handler.
Server.prototype.handleConnect = function (connection) {
    this.addConnection(connection);
    if (this.connection_callback) {
        this.connection_callback(connection);
    }
};

module.exports = { Server: Server, Connection: Connection };
