import { DurableObject } from "cloudflare:workers";
// The game logic is plain JS ported from the original Node server.
// @ts-ignore - no type declarations for the ported game module
import gameModule from "../game/index.js";
// @ts-ignore - JSON import of the server map
import worldMap from "../maps/world_server.json";

const { createGame } = gameModule as {
  createGame: (map: unknown, hooks?: { loadPlayer: (name: string) => { x: number; y: number } | null }) => Game;
};

// Alarm-driven game loop. 50ms => 20 ticks/sec (the original ran at 50 UPS
// via setInterval; we trade a little granularity for a fully native,
// hibernation-friendly loop).
const TICK_MS = 50;
const SNAPSHOT_EVERY_TICKS = Math.round(5000 / TICK_MS); // persist players ~every 5s

interface Game {
  world: any;
  server: any;
  Connection: new (id: string, ws: WebSocket, server: any) => GameConnection;
}

interface GameConnection {
  id: string;
  listen_callback: ((msg: unknown) => void) | null;
  close_callback: (() => void) | null;
  receive: (raw: string) => void;
}

export interface Env {
  WORLD: DurableObjectNamespace<WorldDO>;
  ASSETS: Fetcher;
}

/**
 * WorldDO — the single authoritative game world.
 *
 * Cloudflare primitives showcased:
 *  - Hibernation WebSockets (ctx.acceptWebSocket + webSocket* handlers)
 *  - Alarms API drives the game tick (instead of setInterval)
 *  - SQLite storage persists player position/state for reconnection
 *  - RPC (getStatus) consumed by the entry Worker's /status route
 */
export class WorldDO extends DurableObject<Env> {
  private game: Game | null = null;
  private connections = new Map<WebSocket, GameConnection>();
  private counter = 0;
  private snapshotCounter = 0;
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS players (
         name TEXT PRIMARY KEY,
         x INTEGER, y INTEGER, hp INTEGER,
         armor INTEGER, weapon INTEGER,
         updated_at INTEGER
       )`
    );

    // If we woke up from hibernation/eviction with pre-existing sockets, the
    // in-memory world runtime is gone. For this MVP we close those sockets so
    // clients reconnect and re-handshake (documented tradeoff in the plan).
    const existing = ctx.getWebSockets();
    if (existing.length > 0) {
      for (const ws of existing) {
        try {
          ws.close(1012, "server restarted, please reconnect");
        } catch {
          /* ignore */
        }
      }
    }
  }

  private ensureGame(): Game {
    if (!this.game) {
      this.game = createGame(worldMap, {
        loadPlayer: (name: string) => this.loadPlayer(name),
      });
    }
    return this.game;
  }

  private loadPlayer(name: string): { x: number; y: number } | null {
    if (!name) return null;
    const rows = this.sql
      .exec("SELECT x, y FROM players WHERE name = ? LIMIT 1", name)
      .toArray() as Array<{ x: number; y: number }>;
    if (rows.length) {
      return { x: Number(rows[0].x), y: Number(rows[0].y) };
    }
    return null;
  }

  private savePlayer(p: any): void {
    if (!p || !p.name) return;
    this.sql.exec(
      `INSERT INTO players (name, x, y, hp, armor, weapon, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         x = excluded.x, y = excluded.y, hp = excluded.hp,
         armor = excluded.armor, weapon = excluded.weapon,
         updated_at = excluded.updated_at`,
      p.name,
      p.x | 0,
      p.y | 0,
      (p.hitPoints || 0) | 0,
      (p.armor || 0) | 0,
      (p.weapon || 0) | 0,
      Date.now()
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const game = this.ensureGame();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API: the runtime keeps the socket alive across hibernation.
    this.ctx.acceptWebSocket(server);

    const id = "5" + this.counter++;
    server.serializeAttachment({ id });

    const conn = new game.Connection(id, server, game.server);
    this.connections.set(server, conn);
    // Creates the Player, sends the "go" handshake, wires listen/onClose.
    game.server.handleConnect(conn);

    await this.ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const conn = this.connections.get(ws);
    if (!conn) {
      try {
        ws.close(1012, "reconnect");
      } catch {
        /* ignore */
      }
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    conn.receive(raw);
  }

  webSocketClose(ws: WebSocket): void {
    this.teardownSocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.teardownSocket(ws);
  }

  private teardownSocket(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    const world = this.game?.world;
    if (world) {
      const player = world.players[parseInt(conn.id, 10)];
      if (player) this.savePlayer(player);
    }

    if (conn.close_callback) conn.close_callback();
    this.game?.server.removeConnection(conn.id);
    this.connections.delete(ws);
  }

  private async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  async alarm(): Promise<void> {
    const world = this.game?.world;
    if (world) {
      try {
        world.tick();
      } catch (err) {
        console.error("game tick error:", err);
      }

      this.snapshotCounter += 1;
      if (this.snapshotCounter >= SNAPSHOT_EVERY_TICKS) {
        this.snapshotCounter = 0;
        this.snapshotPlayers();
      }
    }

    // Keep ticking only while players are connected; when the world empties we
    // stop rescheduling and the Durable Object hibernates (no compute billing).
    if (this.connections.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  private snapshotPlayers(): void {
    const world = this.game?.world;
    if (!world) return;
    for (const id in world.players) {
      this.savePlayer(world.players[id]);
    }
  }

  // RPC method consumed by the entry Worker (/status).
  getStatus(): { world: string; connections: number; players: number; entities: number } {
    const world = this.ensureGame().world;
    return {
      world: "world1",
      connections: this.connections.size,
      players: world ? world.playerCount : 0,
      entities: world ? Object.keys(world.entities).length : 0,
    };
  }
}
