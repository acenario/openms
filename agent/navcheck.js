// How connected is a map for nav.js? For every pair of walkable platforms, can nav.plan get from one to
// the other? Lists platforms you can't leave or can't reach (holes in nav.js's edge model, or real
// one-way drops), plus ropes nav can't use. Deterministic, no body needed.
//   bun agent/navcheck.js --map 1010000 [--map 10000 ...]
//   bun agent/navcheck.js --map 1010000 --min 60     ignore platforms shorter than 60 px (decor)
import { parseArgs } from "node:util";
import { navigator } from "./nav.js";

const { values: o } = parseArgs({
  options: { game: { type: "string", default: "http://127.0.0.1:3102" }, map: { type: "string", multiple: true }, min: { type: "string", default: "40" } },
  strict: true,
});
if (!o.map?.length) throw new Error("--map required");
const nav = navigator(new URL(o.game).origin);
for (const id of o.map) {
  const n = await nav(Number(id));
  const plats = n.plats.filter((p) => p.x2 - p.x1 >= Number(o.min));
  const mid = (p) => { const x = Math.round((p.x1 + p.x2) / 2); return { x, y: n.yAt(p, x) - 1 }; };
  const label = (p) => `#${p.id} x ${p.x1}..${p.x2} y≈${Math.round(n.yAt(p, mid(p).x))}`;
  let ok = 0, total = 0;
  const stuckIn = [], unreachable = new Map();
  for (const a of plats) {
    let out = 0;
    for (const b of plats) {
      if (a === b) continue;
      total++;
      const steps = n.plan(mid(a), mid(b));
      if (steps) (ok++, out++);
      else unreachable.set(b, (unreachable.get(b) ?? 0) + 1);
    }
    if (!out && plats.length > 1) stuckIn.push(a);
  }
  console.log(`map ${id}: ${plats.length} platforms ≥${o.min}px, ${ok}/${total} pairs plannable (${total ? Math.round((100 * ok) / total) : 100}%)`);
  for (const p of stuckIn) console.log(`  no way out of ${label(p)}`);
  for (const [p, k] of unreachable) if (k === plats.length - 1) console.log(`  unreachable from anywhere: ${label(p)}`);
  else if (k > (plats.length - 1) / 2) console.log(`  unreachable from ${k}/${plats.length - 1}: ${label(p)}`);
}
process.exit(0);
