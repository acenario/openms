// Agent launcher: runs agent.js as a child and restarts it cleanly when code that brain.js hot
// reload cannot cover changes (body, socket client, atlas, memory, render, shared protocol, the
// client transport/prediction/physics it imports). brain.js edits still hot-reload in place.
//   bun agent/run.js --name Lumen [--port 3310] [--game ...]   (extra flags pass through)
// The child logs out on SIGTERM, so the restart takes ~2 s with no reconnect-grace wait.
// ponytail: polls mtimes every second (fs.watch is unreliable across editors); fine for ~100 files.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const AGENT = import.meta.dir;
const ROOT = join(AGENT, "..", "..");
const WATCH = [
  ...["agent.js", "socket-client.js", "atlas.js", "memory.js", "render.js"].map((f) => join(AGENT, f)),
  join(ROOT, "shared"),
  join(ROOT, "client/src/online"),
  join(ROOT, "client/src/physics"),
];
const DEBOUNCE_MS = 1500;

function files(path, out = []) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return out;
  if (stat.isFile()) return path.endsWith(".js") ? (out.push(path), out) : out;
  for (const entry of readdirSync(path)) files(join(path, entry), out); // watched trees are small
  return out;
}
const stamp = () => {
  const mtimes = new Map();
  for (const root of WATCH) for (const f of files(root)) mtimes.set(f, statSync(f).mtimeMs);
  return mtimes;
};

let child = null;
let restarting = false;
function start() {
  child = Bun.spawn(["bun", join(AGENT, "agent.js"), ...process.argv.slice(2)], {
    stdout: "inherit",
    stderr: "inherit",
  });
  child.exited.then((code) => {
    if (!restarting) {
      console.log(`[run] body exited (${code}); restarting in 5 s`);
      setTimeout(start, 5000);
    }
  });
}

async function restart(changed) {
  restarting = true;
  console.log(`[run] ${changed.map((f) => relative(ROOT, f)).join(", ")} changed — restarting body`);
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(8000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  restarting = false;
  start();
}

let seen = stamp();
let pending = null;
setInterval(() => {
  const now = stamp();
  const changed = [...now].filter(([f, t]) => seen.get(f) !== t).map(([f]) => f);
  seen = now;
  if (!changed.length) return;
  clearTimeout(pending);
  pending = setTimeout(() => restart(changed), DEBOUNCE_MS); // wait for multi-file saves to settle
}, 1000);

for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    restarting = true;
    child?.kill("SIGTERM");
    await Promise.race([child?.exited, Bun.sleep(8000)]);
    process.exit(0);
  });

start();
