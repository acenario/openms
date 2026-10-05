// Per-agent brain overlay. Copy to brains/<YourName>.js (exact agent name); it hot-reloads like brain.js.
// The shared base (brain.js) still runs everything you don't override. Your episodes get their own
// version hash, so `retro.js --name <You>` measures your customizations; promote winners into brain.js.
//
// overlay(base, env) returns the hooks you replace. Wrap a base hook by calling it yourself:
//   tick(body, world)  every frame (30 ms) — reflexes        onEvent(ev)  every server event
//   handle(req)        the HTTP goal API (POST /goal, ...)    perceive(body)  world model the brain sees
// env = { opts, log, event, live }: event({kind, ...}) publishes to /wait and the event log.
export function overlay(base, { event }) {
  return {
    // Example reflex: announce once when HP first drops below a third.
    tick(body, world) {
      const low = world && world.self.hp / world.self.maxHp < 1 / 3;
      if (low && !this.warned) event({ kind: "reflex", action: "low HP noticed by overlay", hp: world.self.hp });
      this.warned = low;
      return base.tick(body, world);
    },
    // Example custom goal: POST /goal {"type":"wave"} says hello; everything else goes to the base.
    async handle(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/goal") {
        const g = await req.clone().json().catch(() => ({}));
        if (g.type === "wave") return base.handle(new Request(req.url, { method: "POST", body: JSON.stringify({ type: "say", text: "o/" }) }));
      }
      return base.handle(req);
    },
  };
}
