// In-map path planning over the map's own footholds and ladders: which platforms connect by a
// jump, a drop-through or a rope. Plans only — brain.js executes the steps.
//   bun agent/nav.js --map 1010000 --from -283,215 --to -259,-25     print a plan
//   import { navigator } from "./nav.js"; const nav = navigator(origin); (await nav(mapId)).plan(from, to)
// Platforms = foothold groups (one connected run of floor). Edges:
//   jump  up to a platform 10–JUMP_UP px higher that overlaps horizontally (MapleStory floors are
//         passable from below);  drop  down+jump to the first platform below;  climb  a ladder/rope
//         from the platform under its bottom to the one at its top. BFS = fewest moves.
//   portal  an in-map teleport portal pair (same map).
//   walk  off a platform end (no wall rising there) onto the first platform below.
// ponytail: long running jumps between distant platforms are not edges.
import { parseArgs } from "node:util";

const JUMP_UP = 70; // highest floor-to-floor gap a standing jump clears (60 px stairs are common)
const SIDE_GAP = 60; // horizontal gap a running jump crosses
const EDGE = 15; // keep take-offs this far from a platform's ends
const WALK_OFF = 25; // walk-off edges land this far past the end (walking momentum carries ~that far)
const pad = (id) => String(id).padStart(9, "0");

export function navigator(origin) {
  let catalog = null;
  const cache = new Map();
  return async function nav(mapId) {
    if (cache.has(mapId)) return cache.get(mapId);
    catalog ??= await (await fetch(`${origin}/generated/catalog.json`)).json();
    const m = await (await fetch(new URL(catalog.maps[pad(mapId)].url, origin))).json();
    const n = build(m.physics, mapId);
    // Monster stats for this map (templateId → {level, maxHP, touch, exp}), for target choice.
    n.mobs = new Map(Object.values(m.life?.templates ?? {}).filter((t) => t.kind === "mob" && t.info)
      .map((t) => [Number(t.originalId), { level: t.info.level, maxHP: t.info.maxHP, touch: t.info.PADamage, exp: t.info.exp }]));
    cache.set(mapId, n);
    return n;
  };
}

function build(physics, mapId) {
  // A platform is a chain of floor footholds linked by prev/next; a wall (vertical foothold) splits
  // the chain, because you can't walk through it — crossing it is a jump edge like any other step.
  const floor = new Map(physics.footholds.filter((f) => f.x1 !== f.x2).map((f) => [f.id, f]));
  const walls = physics.footholds.filter((f) => f.x1 === f.x2);
  const root = new Map([...floor.keys()].map((id) => [id, id]));
  const find = (id) => (root.get(id) === id ? id : (root.set(id, find(root.get(id))), root.get(id)));
  for (const f of floor.values()) for (const n of [f.prev, f.next]) if (floor.has(n)) root.set(find(f.id), find(n));
  const groups = new Map();
  for (const f of floor.values()) {
    const g = find(f.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  // Walls of another foothold group don't block walking (client contacts.js eligible(): same group only) —
  // verified 2026-10-05: walked under Thicket III's block past its x=681 wall. So platforms split only at their own walls.
  const plats = [...groups].map(([id, fs]) => ({
    id, fs,
    x1: Math.min(...fs.map((f) => Math.min(f.x1, f.x2))),
    x2: Math.max(...fs.map((f) => Math.max(f.x1, f.x2))),
  }));
  /** Floor y of platform p at x, or null if p has no floor there. */
  const yAt = (p, x) => {
    for (const f of p.fs) {
      const lo = Math.min(f.x1, f.x2), hi = Math.max(f.x1, f.x2);
      if (x < lo || x > hi) continue;
      return f.x1 === f.x2 ? f.y1 : f.y1 + ((f.y2 - f.y1) * (x - f.x1)) / (f.x2 - f.x1);
    }
    return null;
  };
  /** Platform you stand on at (x,y): floor within 8 px. Else the first floor below (falling). */
  const at = (x, y) =>
    plats.filter((p) => yAt(p, x) !== null && yAt(p, x) >= y - 8).sort((a, b) => yAt(a, x) - yAt(b, x))[0] ?? null;
  const below = (p, x) => plats.filter((q) => q !== p && yAt(q, x) !== null && yAt(q, x) > yAt(p, x) + 5).sort((a, b) => yAt(a, x) - yAt(b, x))[0] ?? null;

  const edges = new Map(plats.map((p) => [p.id, []]));
  for (const p of plats) {
    for (const q of plats) {
      if (p === q) continue;
      // Landing spots on q (both ends and middle); take-off on p straight below (jump up) or up to
      // SIDE_GAP to the side (running jump, dir = which way to hold). First workable pair wins.
      let found = null;
      // Middle first: take-offs near a platform's end risk walking off it (approach overshoots a few px).
      // Also land above p's own middle/ends, so a small step under a wide floor finds its jump-up.
      const pm = Math.round((p.x1 + p.x2) / 2), clip = (x) => Math.max(q.x1 + 20, Math.min(q.x2 - 20, x));
      for (const land of [Math.round((q.x1 + q.x2) / 2), q.x1 + 20, q.x2 - 20, clip(pm), clip(p.x1 + EDGE + 5), clip(p.x2 - EDGE - 5), q.x1 + 8, q.x2 - 8]) {
        // Take-offs straight below, 30/60 px to the side, or from p's last safe spot toward q (ends matter for gaps).
        const ends = [p.x1 + 6 - land, p.x2 - 6 - land].filter((e) => Math.abs(e) <= SIDE_GAP && e !== 0);
        for (const d of [0, -30, 30, -SIDE_GAP, SIDE_GAP, ...ends]) {
          const x = land + d, yp = yAt(p, x), yq = yAt(q, land);
          if (yp === null || yq === null || x < p.x1 + (ends.includes(d) ? 6 : EDGE) || x > p.x2 - (ends.includes(d) ? 6 : EDGE)) continue;
          // Down onto a platform that lies under p at the landing x: you'd land back on p (use drop instead).
          if (yq > yp && yAt(p, land) !== null) continue;
          // Falling from the apex you land on the first floor below it: any other floor between the apex and q's
          // height over the descent (mid-flight to landing) catches the jump instead of q.
          if (plats.some((r) => r !== q && [(x + land) / 2, land].some((cx) => { const yr = yAt(r, cx); return yr !== null && yr > yp - JUMP_UP && yr < yq - 5; }))) continue;
          const gap = yp - yq; // > 0: q is higher; level (|gap| ≤ 10) only across a real gap (p has no floor at land)
          if (d === 0 ? gap > 10 && gap <= JUMP_UP : gap > -JUMP_UP && gap <= JUMP_UP && (Math.abs(gap) > 10 || yAt(p, land) === null)) {
            found = { kind: "jump", x, dir: Math.sign(-d), land, to: q.id };
            break;
          }
        }
        if (found) break;
      }
      if (found) edges.get(p.id).push(found);
    }
    // Walk off an end (no wall rising there) onto the first platform below the landing spot.
    for (const side of [-1, 1]) {
      const end = side < 0 ? p.x1 : p.x2, yEnd = yAt(p, end), lx = end + side * WALK_OFF;
      if (walls.some((w) => Math.abs(w.x1 - end) <= 2 && Math.min(w.y1, w.y2) < yEnd - 5 && Math.max(w.y1, w.y2) > yEnd - 5)) continue;
      const q = plats.filter((r) => r !== p && yAt(r, lx) !== null && yAt(r, lx) > yEnd + 5).sort((a, b) => yAt(a, lx) - yAt(b, lx))[0];
      if (q) edges.get(p.id).push({ kind: "walk", x: lx, dir: side, to: q.id });
    }
    for (const x of [p.x1 + 12, Math.round((p.x1 + p.x2) / 2), p.x2 - 12]) {
      const q = below(p, x);
      if (q && !edges.get(p.id).some((e) => e.kind === "drop" && e.to === q.id)) edges.get(p.id).push({ kind: "drop", x, to: q.id });
    }
  }
  for (const l of physics.ladders) {
    const bottom = plats.filter((p) => yAt(p, l.x) !== null && yAt(p, l.x) >= l.y2 - 5 && yAt(p, l.x) <= l.y2 + 90).sort((a, b) => yAt(a, l.x) - yAt(b, l.x))[0];
    const top = plats.find((p) => yAt(p, l.x) !== null && Math.abs(yAt(p, l.x) - l.y1) <= 12);
    if (bottom && top && bottom !== top)
      edges.get(bottom.id).push({ kind: "climb", x: l.x, to: top.id, ladder: { x: l.x, top: l.y1, bottom: l.y2, rope: !l.ladder } });
  }

  // In-map teleport portals (hidden type-10 pairs whose target is this map, e.g. Lith Harbor's docks ↔ town).
  const portals = physics.portals ?? [];
  for (const src of portals) {
    const dst = src.targetMap === mapId && portals.find((d) => d !== src && d.name === src.targetName);
    const a = dst && at(src.x, src.y), b = dst && at(dst.x, dst.y);
    if (a && b && a !== b) edges.get(a.id).push({ kind: "portal", x: src.x, land: dst.x, portalId: src.id, to: b.id });
  }

  /** Steps from (x,y) to the platform under (tx,ty): [{kind, x, to, toY, ladder?}], [] if already there, null if no path. */
  function plan(from, to) {
    const a = at(from.x, from.y), b = at(to.x, to.y);
    if (!a || !b) return null;
    if (a === b) return [];
    const prev = new Map([[a.id, null]]);
    const queue = [a.id];
    while (queue.length) {
      const id = queue.shift();
      if (id === b.id) break;
      for (const e of edges.get(id)) if (!prev.has(e.to)) (prev.set(e.to, { from: id, e }), queue.push(e.to));
    }
    if (!prev.has(b.id)) return null;
    const steps = [];
    for (let id = b.id; prev.get(id); id = prev.get(id).from) steps.unshift(prev.get(id).e);
    return steps.map((s) => ({ ...s, toY: Math.round(yAt(plats.find((p) => p.id === s.to), s.land ?? s.x) ?? 0) }));
  }
  return { plan, at, yAt, plats, edges };
}

if (import.meta.main) {
  const { values: o } = parseArgs({
    options: { game: { type: "string", default: "http://127.0.0.1:3102" }, map: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
    strict: true,
  });
  const nav = await navigator(new URL(o.game).origin)(Number(o.map));
  const [fx, fy] = o.from.split(",").map(Number), [tx, ty] = o.to.split(",").map(Number);
  const steps = nav.plan({ x: fx, y: fy }, { x: tx, y: ty });
  console.log(steps === null ? "no path" : steps.length ? steps.map((s, i) => `${i + 1}. ${s.kind} at x=${s.x} → floor y≈${s.toY}`).join("\n") : "already on that floor");
}
