import { WorldDO, type Env } from "./world-do";

export { WorldDO };

// Single world instance for this MVP; sharding by zone comes later.
const WORLD_NAME = "world1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket gameplay endpoint -> forwarded to the World Durable Object.
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      const stub = env.WORLD.get(env.WORLD.idFromName(WORLD_NAME));
      return stub.fetch(request);
    }

    // Live status via Durable Object RPC (population, entities, connections).
    if (url.pathname === "/status") {
      const stub = env.WORLD.get(env.WORLD.idFromName(WORLD_NAME));
      const status = await stub.getStatus();
      return Response.json(status);
    }

    // Everything else is a static asset (the BrowserQuest client).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
