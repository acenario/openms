// World knowledge for agents: what a map contains, what NPCs look like, and how to get there.
//   bun agent/atlas.js --map 30000                 map context (exits, NPCs, mobs, platforms)
//   bun agent/atlas.js --near 10000 --hops 4       NPC directory + portrait sheet around a map
//   bun agent/atlas.js --route 10000:30000         maps and portals to walk
// All data comes from the generated catalog/manifests the client itself uses.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assets, composite, sheet } from "./render.js";

const NO_EXIT = 999999999;
const pad = (id) => String(id).padStart(9, "0");

export function atlas(origin) {
  const store = assets(origin);
  let catalog = null;
  const manifests = new Map();
  const getCatalog = async () => (catalog ??= await (await fetch(`${origin}/generated/catalog.json`)).json());
  const manifest = async (mapId) => {
    const key = pad(mapId);
    if (!manifests.has(key)) {
      const descriptor = (await getCatalog()).maps[key];
      if (!descriptor) throw new Error(`map ${mapId} is not packaged`);
      manifests.set(key, fetch(new URL(descriptor.url, origin)).then((r) => r.json()));
    }
    return manifests.get(key);
  };
  const mapName = async (id) => (await getCatalog()).mapNames[Number(id)] ?? `Map ${Number(id)}`;

  /** Plain-language context for one map: the facts an agent needs to act there. */
  async function context(mapId) {
    const m = await manifest(mapId);
    const exits = [];
    for (const p of m.physics.portals) {
      if (p.targetMap === NO_EXIT || !p.targetMap) continue;
      exits.push({ portalId: p.id, name: p.name, x: p.x, y: p.y, to: p.targetMap, toName: await mapName(p.targetMap) });
    }
    const npcs = [], mobs = new Map();
    for (const placement of m.life.placements) {
      const t = m.life.templates[placement.template];
      if (placement.kind === "npc") npcs.push({ lifeId: placement.id, npcId: Number(t.originalId), name: t.name, x: placement.authored.x, y: placement.authored.cy ?? placement.authored.y });
      else mobs.set(t?.name ?? placement.template, (mobs.get(t?.name ?? placement.template) ?? 0) + 1);
    }
    const levels = [...new Set(m.physics.footholds.filter((f) => f.y1 === f.y2).map((f) => f.y1))].sort((a, b) => a - b);
    return {
      mapId: Number(mapId),
      name: await mapName(mapId),
      bounds: m.bounds,
      exits,
      npcs,
      mobs: Object.fromEntries(mobs),
      ladders: m.physics.ladders.map((l) => ({ x: l.x, top: Math.min(l.y1, l.y2), bottom: Math.max(l.y1, l.y2), rope: !l.ladder })),
      platformHeights: levels, // y of flat footholds; smaller y = higher up
    };
  }

  /** Draw an NPC's standing frame from the map region that holds its artwork. */
  async function npcPortrait(mapId, lifeId) {
    const m = await manifest(mapId);
    for (const region of m.regions) {
      const r = await (await fetch(new URL(region.url, origin))).json();
      const entity = r.entities.find((e) => e.kind === "npc" && e.id === lifeId);
      if (!entity) continue;
      const frame = (entity.actions.stand ?? Object.values(entity.actions)[0])[0];
      const texture = (id) => ({ ...m.textures[id], atlasUrl: m.atlases[m.textures[id].atlas].url });
      return composite(frame.parts.slice().sort((a, b) => a.z - b.z), texture, store);
    }
    return null;
  }

  /** Breadth-first over catalog neighbours, then the portal to take on each map. */
  async function route(from, to) {
    const c = await getCatalog();
    const start = pad(from), goal = pad(to);
    const previous = new Map([[start, null]]);
    const queue = [start];
    while (queue.length && !previous.has(goal)) {
      const current = queue.shift();
      for (const next of c.maps[current]?.neighbors ?? []) {
        if (previous.has(next)) continue;
        previous.set(next, current);
        queue.push(next);
      }
    }
    if (!previous.has(goal)) return null;
    const maps = [];
    for (let at = goal; at; at = previous.get(at)) maps.unshift(at);
    const steps = [];
    for (let i = 0; i < maps.length - 1; i++) {
      const exit = (await context(maps[i])).exits.find((e) => pad(e.to) === maps[i + 1]);
      steps.push({ map: Number(maps[i]), name: await mapName(maps[i]), via: exit ?? null, next: Number(maps[i + 1]) });
    }
    return { from: Number(from), to: Number(to), hops: steps.length, steps };
  }

  /** Every map within `hops` portal steps. */
  async function nearby(from, hops) {
    const c = await getCatalog();
    const seen = new Map([[pad(from), 0]]);
    const queue = [pad(from)];
    while (queue.length) {
      const current = queue.shift();
      if (seen.get(current) >= hops) continue;
      for (const next of c.maps[current]?.neighbors ?? [])
        if (!seen.has(next)) (seen.set(next, seen.get(current) + 1), queue.push(next));
    }
    return [...seen].map(([id, distance]) => ({ mapId: Number(id), distance }));
  }

  return { context, npcPortrait, route, nearby, mapName, catalog: getCatalog };
}

// ---------- CLI ----------
if (import.meta.main) {
  const { values: opts } = parseArgs({
    options: {
      game: { type: "string", default: "http://127.0.0.1:3102" },
      map: { type: "string" },
      near: { type: "string" },
      hops: { type: "string", default: "3" },
      route: { type: "string" },
    },
    strict: true,
  });
  const world = atlas(new URL(opts.game).origin);
  if (opts.map) console.log(JSON.stringify(await world.context(opts.map), null, 2));
  if (opts.route) {
    const [from, to] = opts.route.split(":");
    console.log(JSON.stringify(await world.route(from, to), null, 2));
  }
  if (opts.near) {
    const out = join(import.meta.dir, "logs", "atlas");
    mkdirSync(out, { recursive: true });
    const images = [], directory = [];
    for (const { mapId, distance } of await world.nearby(opts.near, Number(opts.hops))) {
      const ctx = await world.context(mapId);
      for (const npc of ctx.npcs) {
        const image = await world.npcPortrait(mapId, npc.lifeId);
        if (!image) continue;
        directory.push({ index: images.length, name: npc.name, npcId: npc.npcId, mapId, mapName: ctx.name, distance });
        images.push(image);
      }
    }
    const file = join(out, `npcs-near-${opts.near}.png`);
    writeFileSync(file, sheet(images, 2));
    writeFileSync(join(out, `npcs-near-${opts.near}.json`), JSON.stringify(directory, null, 2));
    for (const d of directory) console.log(`${String(d.index).padStart(2)}  ${d.name.padEnd(14)} map ${d.mapId} ${d.mapName} (${d.distance} hops)`);
    console.log(`[atlas] portraits left→right in ${file}`);
  }
  process.exit(0);
}
