# BrowserQuest en Cloudflare — Cómo está montado

Este documento explica, con detalle, cómo se ha portado el MMO original de
Mozilla **BrowserQuest** (un servidor Node.js + `websocket-server`) a una
arquitectura **nativa de Cloudflare Workers + Durable Objects**, sin servidores
que mantener y con hibernación (coste cero cuando no hay jugadores).

Todo lo relacionado con el port vive dentro del directorio [`worker/`](.).

---

## 1. Arquitectura de un vistazo

```
Navegador (cliente BrowserQuest sin cambios de gameplay)
        │
        │  HTTP  (HTML, JS, sprites, audio, mapas)      ┌──────────────────────┐
        ├──────────────────────────────────────────────▶│  Worker (src/index.ts)│
        │                                               │   binding ASSETS      │
        │  WebSocket  wss://<host>/ws                    └──────────┬───────────┘
        └──────────────────────────────────────────────────────────┘
                                                                    │  fetch() / RPC
                                                                    ▼
                                                        ┌──────────────────────┐
                                                        │  WorldDO (Durable     │
                                                        │  Object, world1)      │
                                                        │  · WebSockets hibern. │
                                                        │  · Alarms (game loop) │
                                                        │  · SQLite (persist.)  │
                                                        │  · game/ (lógica JS)  │
                                                        └──────────────────────┘
```

Piezas clave:

- **`src/index.ts`** — Worker de entrada. Es el único enrutador.
- **`src/world-do.ts`** — el Durable Object `WorldDO`, el mundo autoritativo.
- **`game/`** — la lógica de juego original del servidor Node, portada a
  ejecutarse dentro del Durable Object.
- **`assets/`** — el cliente BrowserQuest ya construido, servido como estáticos.
- **`maps/world_server.json`** — el mapa del servidor, importado como JSON.

---

## 2. El Worker de entrada (`src/index.ts`)

Un único `fetch` handler que decide qué hacer según la ruta:

- **`/ws`** → exige cabecera `Upgrade: websocket` y reenvía la petición al
  Durable Object `WorldDO` (siempre a la misma instancia con nombre `world1`).
- **`/status`** → llama por **RPC** al método `getStatus()` del DO y devuelve un
  JSON con población, entidades y conexiones activas.
- **cualquier otra ruta** → se sirve desde el binding **`ASSETS`** (el cliente
  estático en `assets/`).

```ts
const stub = env.WORLD.get(env.WORLD.idFromName("world1"));
return stub.fetch(request);           // /ws
// ...
return env.ASSETS.fetch(request);     // estáticos
```

Hoy hay **un solo mundo** (`world1`). El sharding por zona sería tan simple como
derivar el nombre del DO a partir de la zona del jugador.

---

## 3. El mundo autoritativo (`src/world-do.ts`)

`WorldDO extends DurableObject<Env>` concentra todo el estado en vivo. Muestra
cuatro primitivas de Cloudflare trabajando juntas:

### 3.1 WebSockets con hibernación
- En `fetch()` se crea un `WebSocketPair` y se acepta el lado servidor con
  `ctx.acceptWebSocket(server)` (API de hibernación: el runtime mantiene el
  socket vivo aunque el DO se hiberne).
- Cada socket recibe un `id` (`"5" + counter`) que se guarda con
  `serializeAttachment` y se envuelve en una `Connection` de `game/transport.js`.
- Los mensajes entrantes llegan a `webSocketMessage()`, que los reenvía a
  `conn.receive(raw)`. Cierre/errores → `teardownSocket()`.

### 3.2 Bucle de juego con Alarms
- En lugar del `setInterval` del servidor original, el tick se dispara con la
  **Alarms API**: `alarm()` llama a `world.tick()` y reprograma la siguiente
  alarma **solo si quedan conexiones**.
- `TICK_MS = 50` → **20 ticks/seg**. Cuando el mundo se vacía, se deja de
  reprogramar la alarma y el DO **hiberna** (sin facturación de cómputo).

### 3.3 Persistencia con SQLite
- El DO crea una tabla `players (name, x, y, hp, armor, weapon, updated_at)`.
- `savePlayer()` hace *upsert* de la posición/estado; se ejecuta al desconectar
  y en *snapshots* periódicos (`SNAPSHOT_EVERY_TICKS`, ~cada 5 s).
- `loadPlayer(name)` consulta la posición guardada para que un jugador que
  vuelve con el mismo nombre reaparezca donde lo dejó.

### 3.4 RPC
- `getStatus()` es un método RPC consumido por la ruta `/status` del Worker de
  entrada; devuelve `{ world, connections, players, entities }`.

### 3.5 Tradeoff documentado: reinicio tras hibernación
Si el DO despierta de la hibernación/desalojo con sockets preexistentes, el
runtime en memoria del mundo ya no está. Para este MVP, el constructor **cierra
esos sockets** (`close(1012, ...)`) para que los clientes reconecten y repitan el
handshake. Es un compromiso conocido y anotado en el propio código.

---

## 4. La lógica de juego portada (`game/`)

Es el código del servidor original (`server/js/`) adaptado al bundler de Workers.

### 4.1 El problema del "global leakage"
El servidor original dependía de la fuga de globales de CommonJS no estricto de
Node (p. ej. `Types = {...}`, `module.exports = Player = ...`), de modo que unos
módulos referenciaban las clases de otros como globales sin declarar. Bajo el
bundler de Workers (ESM estricto) eso **no ocurre**.

`game/index.js` lo resuelve con `setupGlobals()`:
1. Registra explícitamente los singletons y clases en `globalThis`
   (`log`, `_`, `Class`, `Types`, `Utils`, `Formulas`, `Properties`, `Messages`).
2. Requiere la jerarquía de clases **en orden de dependencia** (`entity` →
   `character` → `mob` → `item` → ... → `player`), y cada módulo se
   auto-registra en `globalThis` al evaluarse.

`createGame(mapJSON, hooks)` construye un `Server`, un `World("world1", 200,
server)`, arranca el mundo (`world.run(mapJSON)`) y devuelve `{ world, server,
Connection }` — justo lo que el Durable Object necesita para conducirlo. El hook
`loadPlayer` se engancha en `player.onRequestPosition()` para respetar la
posición persistida.

### 4.2 El transporte (`game/transport.js`)
Sustituye a `server/js/ws.js` (que usaba el módulo Node `websocket-server`).
Reimplementa **solo** la interfaz que `worldserver.js` y `player.js` esperan:

- `Server`: `onConnect`, `addConnection`, `removeConnection`, `getConnection`,
  `forEachConnection`, `broadcast`, `onError`, `handleConnect`.
- `Connection`: `id`, `listen(cb)`, `onClose(cb)`, `send(msg)`, `sendUTF8(data)`,
  `close()`, `receive(raw)`.

El **formato de cable es JSON** (`JSON.stringify` / `JSON.parse`), en línea con
el cliente configurado con `useBison = false`.

---

## 5. El cliente (`assets/`)

Es el cliente BrowserQuest ya compilado, servido tal cual por el binding
`ASSETS`. Solo se han tocado dos ficheros para que hable con el Worker:

- **`assets/js/config.js`** — ya no necesita un fichero de config externo:
  toma `host`/`port` de `window.location`, es decir, se conecta al **mismo
  origen** desde el que se sirvió.
- **`assets/js/gameclient.js`** — construye la URL del socket con el esquema
  correcto y la ruta `/ws`:

  ```js
  var protocol = (window.location.protocol === "https:") ? "wss://" : "ws://",
      portPart = (this.port) ? (":" + this.port) : "",
      url = protocol + this.host + portPart + "/ws";
  ```

Resultado: en producción el cliente se conecta a `wss://<host>/ws` sin
configuración manual de host/puerto.

---

## 6. Configuración de Wrangler (`wrangler.jsonc`)

```jsonc
{
  "name": "browserquest",
  "main": "src/index.ts",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],   // require(), Buffer, etc.
  "assets": { "directory": "./assets", "binding": "ASSETS" },
  "durable_objects": {
    "bindings": [{ "name": "WORLD", "class_name": "WorldDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["WorldDO"] }  // SQLite-backed DO
  ],
  "observability": { "enabled": true }
}
```

Puntos a destacar:
- **`nodejs_compat`** permite el estilo `require()`/CommonJS de `game/`.
- **`assets`** sirve el cliente estático con el binding `ASSETS`.
- **`new_sqlite_classes`** hace que `WorldDO` use el backend **SQLite** (necesario
  para `ctx.storage.sql`).
- **`observability`** activa logs/trazas en el dashboard de Cloudflare.

---

## 7. Puesta en marcha

### Requisitos
- Node.js + npm
- Cuenta de Cloudflare (para `deploy`) y `wrangler` autenticado

### Comandos (desde `worker/`)

```bash
npm install        # dependencias (wrangler, tipos, underscore, playwright)
npm run dev        # wrangler dev -> desarrollo local con DO + assets
npm run deploy     # wrangler deploy -> publica en Cloudflare
npm run types      # wrangler types -> genera los tipos de los bindings
```

Rutas expuestas una vez arrancado:
- `/` y estáticos → cliente del juego.
- `/ws` → WebSocket de gameplay (WorldDO).
- `/status` → JSON en vivo con población/entidades/conexiones.

### Despliegue actual
El proyecto está desplegado en **`https://browserquest.carluve.workers.dev`**.

---

## 8. Prueba de humo (`repro.mjs`)

Script de **Playwright** que abre la URL, teclea un nombre, pulsa "play" y
verifica que `document.body` obtiene la clase `started`. Registra la actividad
del WebSocket (`framesent` / `framereceived`) para depurar el handshake.

```bash
node repro.mjs                                   # usa la URL de producción
node repro.mjs http://localhost:8787             # contra wrangler dev
```

---

## 9. Mapa de correspondencias (original → port)

| Servidor Node original        | Equivalente en el port                          |
|-------------------------------|-------------------------------------------------|
| `server/js/ws.js`             | `worker/game/transport.js` (Server/Connection)  |
| `server/js/main.js` (arranque)| `worker/game/index.js` (`createGame`)           |
| `setInterval` (game loop)     | Alarms API en `WorldDO.alarm()`                 |
| Estado en memoria del proceso | Durable Object `WorldDO` (una instancia)        |
| Sin persistencia real         | SQLite dentro del DO (`players`)                 |
| `websocket-server` (Node)     | WebSockets con hibernación de Cloudflare         |
| Estáticos servidos por Node   | Binding `ASSETS` del Worker                      |
| `server/maps/world_server.json` | `worker/maps/world_server.json` (import JSON) |

El resto de la lógica de juego (`worldserver.js`, `player.js`, `mob.js`,
`map.js`, etc.) se reutiliza **prácticamente sin cambios**.
