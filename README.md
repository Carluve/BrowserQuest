# BrowserQuest — Reborn on Cloudflare

BrowserQuest is a HTML5/JavaScript multiplayer game experiment. This repository
takes the original **Mozilla BrowserQuest** and **ports it natively to Cloudflare
Workers, Durable Objects and SQLite** — no long-running Node.js server, no
machines to maintain, and **zero compute cost when nobody is playing**.

**Live demo:** https://browserquest.carluve.workers.dev

---

## Where this project comes from

### 1. The original (Mozilla, 2012)

BrowserQuest was released by **Mozilla** in 2012 as a technology showcase for the
modern web: a pixel-art MMORPG that ran entirely in the browser using the HTML5
`<canvas>` element and **WebSockets** for real-time multiplayer. It was built by
[Little Workshop](http://www.littleworkshop.fr) in collaboration with Mozilla,
and open-sourced so that anyone could learn from it.

Its architecture had two clearly separated halves:

- A **client** (`client/`) — sprites, tile maps, audio and all rendering on
  `<canvas>`, wired together with RequireJS.
- A **Node.js server** (`server/`) — the authoritative game world (players, mobs,
  combat, loot, chests, NPCs) held in the memory of a live process, with a
  `setInterval` driving the game loop at roughly 20 ticks per second, and Node's
  `websocket-server` module handling connections.

There are also `shared/` (code common to both sides) and `tools/` (the Tiled map
exporter that turns `.tmx` maps into the JSON the game consumes).

### 2. The problem with the original design

The game was wonderful, but it was very much of its time. It required a
**dedicated Node.js server running 24/7**: a process consuming resources even
when not a single player was connected, needing patching, scaling and
babysitting. Fun to run for a weekend; painful to keep alive for years.

### 3. The rebirth (this repository)

The idea behind this port was simple to state and interesting to solve:
**what if there were no server at all?** What if the entire game lived on
Cloudflare's edge, with nothing to administer, and cost nothing while idle?

That is exactly what lives in [`worker/`](worker/). The whole game world is
modelled as a single **Durable Object** (`WorldDO`), and four Cloudflare
primitives do the heavy lifting:

- **Hibernatable WebSockets** replace Node's `websocket-server`. Connections
  survive while the object sleeps, so there is no compute cost during quiet
  periods.
- **The Alarms API** replaces the original `setInterval` game loop. Each alarm
  runs one `tick()` and schedules the next — but only while players remain.
  When the last player leaves, the world stops scheduling and **hibernates**.
- **Embedded SQLite** adds something the original never had: **real player
  persistence**. Return with the same name and you respawn where you left off.
- **RPC** exposes a live `/status` endpoint reporting population, entities and
  active connections.

The trickiest part of the port was the original code's reliance on non-strict
CommonJS **global leakage** (variables such as `Types` and `Player` assigned
without `var`, then referenced as bare globals elsewhere). Under the Workers
bundler's strict ESM this simply does not happen, so the game bootstrap
explicitly registers those singletons and classes on `globalThis` in dependency
order. The upshot: the original game logic runs **almost entirely unchanged**,
and the client was touched in only two files (to connect back to the same origin
at `wss://<host>/ws`).

For the full technical breakdown of the port, see **[`worker/SETUP.md`](worker/SETUP.md)**.

---

## A short timeline (where it comes from)

```
2012  ──▶  Mozilla + Little Workshop release BrowserQuest.
           HTML5 <canvas> client  +  Node.js server (websocket-server, setInterval loop).

  …        Great demo, but it needs a Node process running 24/7.

2026  ──▶  Native Cloudflare port (this repo, worker/).
           One world = one Durable Object. Hibernatable WebSockets,
           Alarms game loop, SQLite persistence, RPC status.
           Live at browserquest.carluve.workers.dev — £0 while idle.
```

---

## Architecture

The original architecture and the Cloudflare port, side by side:

```
        ORIGINAL (Mozilla, 2012)                 CLOUDFLARE PORT (this repo)

  ┌───────────────┐                        ┌───────────────┐
  │   Browser     │                        │   Browser     │
  │ canvas client │                        │ canvas client │
  └──────┬────────┘                        └──────┬────────┘
         │ WebSocket                              │ HTTP + WebSocket
         ▼                                        ▼
  ┌───────────────────────┐              ┌────────────────────────────┐
  │  Node.js server        │              │  Worker  (src/index.ts)     │
  │  · websocket-server     │              │  · ASSETS binding (client)  │
  │  · setInterval loop     │              │  · routes /ws, /status      │
  │  · world state in RAM   │              └──────────────┬─────────────┘
  │  · no persistence       │                             │ fetch() / RPC
  └───────────────────────┘                             ▼
      (always-on process)                 ┌────────────────────────────┐
                                          │  WorldDO (Durable Object)    │
                                          │  · hibernatable WebSockets   │
                                          │  · Alarms API = game loop    │
                                          │  · SQLite = persistence      │
                                          │  · game/ (original JS logic) │
                                          └────────────────────────────┘
                                              (hibernates when empty)
```

### Request flow (the port)

The entry Worker is a single router; everything stateful lives in one Durable
Object named `world1`:

```
Browser
  │
  ├─ GET /            ─────────────▶ Worker ─▶ ASSETS ─▶ HTML/JS/sprites/audio
  │
  ├─ WS  /ws          ─────────────▶ Worker ─▶ WORLD.idFromName("world1")
  │                                              └─▶ WorldDO.fetch()  (WebSocketPair,
  │                                                   acceptWebSocket, handshake "go")
  │        ◀── real-time game frames (JSON) ──────────┘
  │
  └─ GET /status      ─────────────▶ Worker ─▶ WorldDO.getStatus()  (RPC)
                                                 └─▶ { world, connections,
                                                       players, entities }
```

### Game loop (Alarms, not setInterval)

```
  player connects ─▶ ensureAlarm() ─▶ setAlarm(now + 50ms)
                                            │
                                            ▼
                        ┌───────────────────────────────────────┐
                        │  alarm():                              │
                        │    world.tick()      (20 ticks/sec)    │
                        │    every ~5s -> snapshot players (SQL) │
                        │    connections > 0 ? reschedule +50ms  │
                        └───────────────────┬───────────────────┘
                                            │ no connections left
                                            ▼
                                   stop scheduling ─▶ Durable Object HIBERNATES
                                                      (zero compute cost)
```

---

## Repository layout

| Path        | What it is                                                          |
|-------------|----------------------------------------------------------------------|
| `client/`   | Original Mozilla HTML5 client (source, RequireJS build).             |
| `server/`   | Original Mozilla Node.js server (kept for reference).                |
| `shared/`   | Code shared between the original client and server.                  |
| `tools/`    | Tiled `.tmx` → JSON map exporter.                                    |
| `bin/`      | Original client build script.                                        |
| `worker/`   | **The Cloudflare port** (Workers + Durable Objects + SQLite).        |

---

## Running the port

From the `worker/` directory:

```bash
npm install
npm run dev      # local development with Durable Objects + static assets
npm run deploy   # publish to Cloudflare
```

Routes: `/` and static files serve the game client, `/ws` is the gameplay
WebSocket handled by the `WorldDO` Durable Object, and `/status` returns live
world statistics as JSON. See [`worker/SETUP.md`](worker/SETUP.md) for details.

---

## Documentation

- **[`worker/SETUP.md`](worker/SETUP.md)** — how the Cloudflare port is built and run.
- `client/` and `server/` — original Mozilla documentation for the source game.

---

## Licence

Code is licensed under **MPL 2.0**. Content is licensed under **CC-BY-SA 3.0**.
See the `LICENSE` file for details.

---

## Credits

Original game created by **Mozilla** and [Little Workshop](http://www.littleworkshop.fr):

* Franck Lecollinet — [@whatthefranck](http://twitter.com/whatthefranck)
* Guillaume Lecollinet — [@glecollinet](http://twitter.com/glecollinet)

Cloudflare Workers / Durable Objects port and documentation by
**Carlos Luengo** (`carluve`), written up together with **Chema Alonso** for the
*El Lado del Mal* blog.