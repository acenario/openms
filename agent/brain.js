// Hot-reloadable agent behaviors: perception, goals, reflexes, NPC dialogue, map context and the
// HTTP goal API. agent.js (the body) keeps the socket and re-imports this file when it is saved,
// carrying goal/episode/state across via snapshot()/restore() — edit behaviors without a restart.
// Bound by attach(): opts, log, event, live (body-owned state), VERSION, atlasWorld/world.
import { readFileSync } from "node:fs";
let opts, log, event, live, VERSION, atlasWorld, world;
export function attach(env) {
  ({ opts, log, event, live } = env);
  VERSION = env.version;
  atlasWorld = world = env.atlas;
}

const TICK_MS = 50;
const STUCK_TICKS = 16; // ~0.8 s without horizontal progress
const NEAR_X = 50;
const PORTAL_X = 8; // server checks its own (slightly lagging) copy of our position; 13 px was rejected
const PORTAL_RETRY_MS = 1500;
const PORTAL_TRIES = 6;
const HOP_TIMEOUT_MS = 60000;


// ---------- perception ----------
function perceive(body) {
  const m = body.transport.model;
  const sim = body.self();
  if (!m?.self?.entity || !sim) return null;
  const list = Array.isArray(m.entities) ? m.entities : [...(m.entities?.values?.() ?? [])];
  const selfId = m.self.entity.id;
  const pos = (e) => ({ x: Math.round(e.position?.x ?? 0), y: Math.round(e.position?.y ?? 0) });
  return {
    mapId: m.field?.mapId ?? null,
    self: {
      x: Math.round(sim.x),
      y: Math.round(sim.y),
      state: sim.state,
      facing: sim.facing,
      exp: m.self.exp,
      hp: m.self.hp,
      maxHp: m.self.maxHp,
      mp: m.self.mp,
      maxMp: m.self.maxMp,
      level: m.self.level,
      job: m.self.job,
      ap: m.self.ap,
      sp: m.self.sp,
      stats: m.self.stats,
    },
    players: list
      .filter((e) => e.kind === "player" && e.id !== selfId)
      .map((e) => ({ id: e.id, name: e.appearance?.name ?? null, ...pos(e) })),
    mobs: list
      .filter((e) => e.kind === "mob" && (e.mobState?.hp ?? 1) > 0)
      .map((e) => ({ id: e.id, templateId: e.templateId, hp: e.mobState?.hp ?? null, maxHp: e.mobState?.maxHP ?? null, ...pos(e) })),
    npcs: list.filter((e) => e.kind === "npc").map((e) => ({ id: e.id, templateId: e.templateId, ...pos(e) })),
    // Breakable boxes etc.: basic attacks whose impact overlaps them advance their state (server strikeReactor).
    reactors: list
      .filter((e) => e.kind === "reactor")
      .map((e) => ({ id: e.id, templateId: e.templateId, state: e.reactor?.state, phase: e.reactor?.phase, visible: e.reactor?.visible, ...pos(e) })),
    drops: list
      .filter((e) => e.kind === "drop")
      .map((e) => ({ id: e.id, item: e.dropInfo?.itemId ?? e.dropInfo?.id ?? null, meso: e.dropInfo?.meso ?? null, state: e.dropMotion?.state ?? null, ...pos(e) })),
  };
}

// ---------- reflex layer (virtual keys) ----------
function steer(held, dir) {
  held.left = dir === "left";
  held.right = dir === "right";
}
/** Down + jump drops through the current platform (original MapleStory down-jump). */
function dropThrough(held) {
  held.down = true;
  jump(held);
  setTimeout(() => (held.down = false), 150);
}
function jump(held) {
  held.jump = true;
  held.jumpPressed = true;
  setTimeout(() => (held.jump = false), 90);
}

let goal = { type: "idle" };
let episode = null;
const stuck = { lastX: null, ticks: 0, lastJump: 0 };

function startEpisode(newGoal, world) {
  endEpisode("replaced", world);
  goal = newGoal;
  if (goal.type === "idle") return;
  episode = {
    goal,
    version: VERSION,
    started: Date.now(),
    start: world?.self ?? null,
    metrics: { distance: 0, jumps: 0, stuck: 0, hpLost: 0, nearTicks: 0, ticks: 0 },
    lastSelf: world?.self ?? null,
  };
}

function endEpisode(outcome, world, reason = null) {
  if (!episode) return;
  const { lastSelf, ...rest } = episode;
  log("episodes.jsonl", { ...rest, outcome, reason, durationMs: Date.now() - episode.started, end: world?.self ?? lastSelf });
  episode = null;
  goal = { type: "idle" };
}

function track(world) {
  if (!episode) return;
  const m = episode.metrics;
  const prev = episode.lastSelf;
  m.ticks++;
  if (prev) {
    m.distance += Math.abs(world.self.x - prev.x) + Math.abs(world.self.y - prev.y);
    m.hpLost += Math.max(0, prev.hp - world.self.hp);
  }
  episode.lastSelf = world.self;
}

function approach(held, world, tx, ty, near = NEAR_X) {
  const dx = tx - world.self.x;
  if (Math.abs(dx) <= near) {
    steer(held, null);
    stuck.ticks = 0;
    return true;
  }
  steer(held, dx > 0 ? "right" : "left");
  const moved = stuck.lastX === null || Math.abs(world.self.x - stuck.lastX) >= 1;
  stuck.ticks = moved ? 0 : stuck.ticks + 1;
  stuck.lastX = world.self.x;
  const targetAbove = ty < world.self.y - 60 && Math.abs(dx) < 150;
  if ((stuck.ticks >= STUCK_TICKS || targetAbove) && Date.now() - stuck.lastJump > 700) {
    if (stuck.ticks >= STUCK_TICKS && episode) episode.metrics.stuck++;
    if (episode) episode.metrics.jumps++;
    stuck.lastJump = Date.now();
    stuck.ticks = 0;
    jump(held);
  }
  return false;
}

/** Walk the planned route: on each map, reach the exit portal and ask to enter it. */
/**
 * Reach a portal (walk, drop/jump to its level) and ask to enter it. Shared by travel and
 * follow. `hop` is per-map retry state. Returns a failure reason, or null while in progress.
 */
function usePortal(body, world, via, hop) {
  const held = body.held;
  // Long nav paths (tall maps: 16 steps on The Forest South of Ellinia) get 8 s more per planned step.
  if (Date.now() - hop.started > HOP_TIMEOUT_MS + (hop.navSteps ?? 0) * 8000) return `could not reach portal ${via.name} at ${via.x},${via.y} (${whyStuck(world)})`;
  if (navigating(body, world)) return null;
  // On another platform than the portal: walk a nav.js path to it (drops, jumps, ropes) instead of guessing.
  const nav = world.self.state === "ground" ? navFor(world.mapId) : null;
  if (nav && Date.now() - (hop.navTry ?? 0) > 1500 && nav.at(world.self.x, world.self.y)?.id !== nav.at(via.x, via.y)?.id) {
    hop.navTry = Date.now();
    if (startNav(world, via)) return (hop.navSteps = Math.max(hop.navSteps ?? 0, goal.nav.steps.length)), null;
  }
  const at = approach(held, world, via.x, via.y, PORTAL_X);
  const level = Math.abs(via.y - world.self.y) < 60;
  if (at && !level && world.self.state === "ground" && Date.now() - stuck.lastJump > 800) {
    // Lined up but on the wrong platform: drop through if the portal is below, jump if above.
    stuck.lastJump = Date.now();
    episode.metrics.jumps++;
    if (via.y > world.self.y) (dropThrough(held), (episode.metrics.drops = (episode.metrics.drops ?? 0) + 1));
    else jump(held);
    return null;
  }
  if (!at || !level || world.self.state !== "ground" || Date.now() - hop.lastTry < PORTAL_RETRY_MS) return null;
  if (body.transport.status !== "active") return null; // commands are refused while synchronizing
  if (hop.tries >= PORTAL_TRIES) return `portal ${via.name} refused ${hop.tries}x (${episode.lastPortal})`;
  hop.tries++;
  hop.lastTry = Date.now();
  episode.metrics.portalTries = (episode.metrics.portalTries ?? 0) + 1;
  const ep = episode;
  // Transient refusals (transport resyncing, server busy) don't use up a try; wait a little longer instead.
  const transient = (code) => {
    if (!["NOT_ACTIVE", "SERVER_BUSY", "PENDING_OPERATION_LIMIT"].includes(code)) return;
    hop.tries--;
    hop.lastTry = Date.now() + 1500;
  };
  body.transport.command({ kind: "portal.enter", portalId: via.portalId }).then(
    (r) => ((ep.lastPortal = r?.code ?? r?.status ?? r), transient(ep.lastPortal), console.log("[portal]", JSON.stringify(r))),
    (e) => ((ep.lastPortal = e.code ?? e.message), transient(ep.lastPortal), console.log("[portal] error", e.code ?? e.message)),
  );
  return null;
}

const freshHop = (map) => ({ map, started: Date.now(), tries: 0, lastTry: 0 });

function travel(body, world) {
  if (world.mapId === goal.map) return endEpisode("success", world);
  const step = goal.plan.find((s) => s.map === world.mapId);
  if (!step?.via) return endEpisode("failed", world, `off route on map ${world.mapId}`);
  if (goal.hop?.map !== world.mapId) goal.hop = freshHop(world.mapId);
  const failure = usePortal(body, world, step.via, goal.hop);
  if (failure) endEpisode("failed", world, `${failure} on ${step.name}`);
}

/** Walk to a ladder/rope, hold up to grab and climb, keep holding to step off at the top. */
function climb(body, world) {
  const held = body.held;
  const { ladder } = goal;
  const onLadder = world.self.state !== "ground" && world.self.state !== "air";
  if (world.self.y <= ladder.top + 4 && world.self.state === "ground") {
    held.up = false;
    return endEpisode("success", world);
  }
  if (Date.now() - episode.started > 20000) {
    held.up = false;
    return endEpisode("timeout", world, `stuck at ${world.self.x},${world.self.y} state ${world.self.state}`);
  }
  if (onLadder || held.up) {
    steer(held, null);
    held.up = true;
    if (!onLadder && world.self.state === "ground" && Math.abs(world.self.x - ladder.x) > 10) held.up = false; // missed: re-approach
    return;
  }
  if (!approach(held, world, ladder.x, world.self.y, 4)) return;
  held.up = true;
  // Ladder starts above us: jump while holding up to grab it (jump-grab).
  if (ladder.bottom < world.self.y - 10 && Date.now() - stuck.lastJump > 700) {
    stuck.lastJump = Date.now();
    episode.metrics.jumps++;
    jump(held);
  }
}

/**
 * Ladder sub-goal shared by follow and hunt: goal.climbing = a ladder to ride to its top.
 * climbing() drives it and returns true while it is in charge; startClimbToward() picks one.
 */
function climbing(held, world) {
  const sub = goal.climbing;
  if (!sub) return false;
  const onLadder = world.self.state === "ladder";
  if ((!onLadder && world.self.state === "ground" && world.self.y <= sub.top + 4) || Date.now() - sub.started > 15000) {
    goal.climbing = null;
    held.up = false;
    return false;
  }
  if (onLadder || Math.abs(world.self.x - sub.x) <= 4) {
    steer(held, null);
    held.up = true;
    // Jump-grab only once stopped: walking momentum carried jumps ~40 px past the ladder (A Hill West of Henesys x=-973,
    // bottom 26 px above the floor — ground capture reaches only 20 px, so it needs the falling grab).
    const still = true; // A/B: was Math.abs(world.self.x - (sub.lastX ?? NaN)) < 0.5
    sub.lastX = world.self.x;
    if (!onLadder && still && world.self.state === "ground" && sub.bottom < world.self.y - 10 && Date.now() - stuck.lastJump > 700) (stuck.lastJump = Date.now(), jump(held));
  } else approach(held, world, sub.x, world.self.y, 4);
  return true;
}
function startClimbToward(world, targetY) {
  const reachable = (live.ladders ?? []).filter((l) => world.self.y - 40 > l.top && world.self.y <= l.bottom + 90);
  const byDistance = (a, b) => Math.abs(a.x - world.self.x) - Math.abs(b.x - world.self.x);
  // Prefer one that reaches the target's floor; else the one that lifts us highest (a stepping stone,
  // the next ladder is picked from the new floor). ponytail: greedy, no real graph search.
  const ladder = reachable.filter((l) => l.top <= targetY + 10).sort(byDistance)[0] ??
    reachable.sort((a, b) => a.top - b.top || byDistance(a, b))[0];
  if (!ladder || Math.abs(ladder.x - world.self.x) >= 400) return false;
  goal.climbing = { ...ladder, started: Date.now() };
  episode.metrics.climbs = (episode.metrics.climbs ?? 0) + 1;
  return true;
}

// ---------- in-map navigation (nav.js plans platform paths; this executes them) ----------
const navMaps = new Map(); // mapId -> planner | "loading"
let navigatorFn = null;
function navFor(mapId) {
  const n = navMaps.get(mapId);
  if (n && n !== "loading") return n;
  if (!n) {
    navMaps.set(mapId, "loading");
    // Imported per brain load (fresh specifier) so nav.js edits hot-reload along with brain.js.
    navigatorFn ??= import(`./nav.js?v=${Date.now()}`).then((m) => m.navigator(new URL(opts.game).origin));
    navigatorFn.then((nav) => nav(mapId)).then((p) => navMaps.set(mapId, p), () => navMaps.delete(mapId));
  }
  return null;
}
/** Plan a path to target's floor into goal.nav; false when unplannable (callers fall back). */
function startNav(world, target) {
  const n = navFor(world.mapId);
  const steps = n?.plan(world.self, target);
  if (!steps?.length) return false;
  goal.nav = { steps, i: 0, stepAt: Date.now() };
  if (episode) episode.metrics.navs = (episode.metrics.navs ?? 0) + 1; // survival nav may run between episodes
  return true;
}
const NAV_STEP_MS = 9000;
/** One-line reason for a movement timeout: where we are, what nav was doing, what failed last. */
function whyStuck(world, target) {
  const s = world.self, m = episode?.metrics ?? {};
  const step = goal.nav?.steps?.[goal.nav.i];
  return [
    `at ${s.x},${s.y} (${s.state})`,
    target ? `target ${target.x},${target.y ?? "-"}` : null,
    step ? `on nav step ${step.kind} at x=${step.x} → y≈${step.toY}` : null,
    m.lastNavFail ? `last nav fail: ${m.lastNavFail}` : null,
    m.stuck ? `stuck ${m.stuck}×` : null,
  ].filter(Boolean).join("; ");
}
/** Execute goal.nav one step at a time: walk to the step's x, then jump / drop / climb. */
function navigating(body, world) {
  const nav = goal.nav;
  if (!nav) return false;
  const held = body.held;
  if (climbing(held, world)) return true;
  const step = nav.steps[nav.i];
  const here = world.self.state === "ground" ? navFor(world.mapId)?.at(world.self.x, world.self.y) : null;
  // Budget: 9 s for the move itself plus the walk to its take-off (~100 px/s; a 1100 px slope walk timed out at 9 s).
  if (step && nav.walkFor !== nav.i) (nav.walkFor = nav.i), (nav.walkMs = Math.abs(world.self.x - step.x) * 10);
  if (!step || Date.now() - nav.stepAt > NAV_STEP_MS + (nav.walkMs ?? 0)) {
    if (step) {
      const m = episode?.metrics ?? {};
      m.navFails = (m.navFails ?? 0) + 1;
      // Which moves time out (jump / drop / climb, and side jumps as "jump±"), to aim nav.js fixes.
      const kind = step.kind === "jump" && step.dir ? "jump±" : step.kind;
      (m.navFailKinds ??= {})[kind] = (m.navFailKinds[kind] ?? 0) + 1;
      m.lastNavFail = `${kind} at x=${step.x} from ${world.self.x},${world.self.y} → floor ${step.toY}`;
    }
    goal.nav = null;
    return false;
  }
  if (here?.id === step.to) {
    nav.i++;
    nav.stepAt = Date.now();
    return true;
  }
  if (step.kind === "climb") {
    goal.climbing = { ...step.ladder, started: Date.now() };
    return true;
  }
  if (world.self.state !== "ground") return true; // mid-air: let the jump/drop finish
  if (step.kind === "portal") {
    // In-map teleport portal (nav.js): stand on it and enter; the server teleports us (world.teleport).
    if (!approach(held, world, step.x, world.self.y, PORTAL_X - 2)) return true;
    if (Date.now() - (nav.portalAt ?? 0) < 1500 || body.transport.status !== "active") return true;
    nav.portalAt = Date.now();
    body.transport.command({ kind: "portal.enter", portalId: step.portalId }).then(
      (r) => console.log("[nav portal]", r?.code ?? r?.status),
      (e) => console.log("[nav portal] error", e.code ?? e.message),
    );
    return true;
  }
  if (!approach(held, world, step.x, world.self.y, 4)) return true;
  if (Date.now() - stuck.lastJump < 900) return true;
  stuck.lastJump = Date.now();
  if (step.kind === "drop") return dropThrough(held), true;
  if (step.dir) {
    steer(held, step.dir > 0 ? "right" : "left"); // running jump toward the landing platform
    setTimeout(() => steer(held, null), 350);
  }
  jump(held);
  return true;
}

const ATTACK_RANGE = 45; // stand-off from the target, px
const ATTACK_EVERY_MS = 650;
const TARGET_TIMEOUT_MS = 20000;
const GAVE_UP_MS = 45000; // a mob we failed to reach is skipped this long, then becomes a candidate again
const TOUCH_SCALE = 0.5; // calibration: Shroom PADamage 17 took 4–8 HP from an unarmoured lv 3–4 beginner
const LEVEL_DY = 40; // same floor: attacks only connect when the mob is within this vertical distance

/** Hunt: nearest mob (same level first), stand off facing it, tap attack. Server resolves damage. */
function hunt(body, world) {
  const held = body.held;
  const m = episode.metrics;
  m.attacks ??= 0; m.kills ??= 0;
  episode.startExp ??= world.self.exp;
  m.expGained = (world.self.exp ?? 0) - (episode.startExp ?? 0);
  if (navigating(body, world)) return; // following a platform path to the target's floor
  if (climbing(held, world)) return; // riding a ladder up to the target's floor
  // Loot first: walk onto the nearest landed drop and pick it up (browser Z key = drop.pickup).
  const drop = world.drops
    .filter((d) => d.state !== "launching" && !(goal.triedDrops ??= {})[d.id] && Math.abs(d.y - world.self.y) < 60)
    .sort((a, b) => Math.abs(a.x - world.self.x) - Math.abs(b.x - world.self.x))[0];
  if (drop && Math.abs(drop.x - world.self.x) < 400) {
    if (!approach(held, world, drop.x, drop.y, 10)) return;
    steer(held, null);
    if (Date.now() - (goal.lastPick ?? 0) < 400 || body.transport.status !== "active") return;
    goal.lastPick = Date.now();
    goal.triedDrops[drop.id] = (goal.triedDrops[drop.id] ?? 0) + 1;
    m.pickups = (m.pickups ?? 0) + 1;
    body.transport.command({ kind: "drop.pickup", dropId: drop.id }).then(
      (r) => console.log("[pickup]", r?.code ?? r?.status),
      (e) => console.log("[pickup] error", e.code ?? e.message),
    );
    return;
  }
  const unclaimed = world.drops.some((d) => !goal.triedDrops?.[d.id] && Math.abs(d.x - world.self.x) < 400);
  const settling = Date.now() - (goal.lastKill ?? 0) < 1500;
  if (goal.limit && m.kills >= goal.limit && !unclaimed && !settling) return endEpisode("success", world);
  if (goal.limit && m.kills >= goal.limit) return steer(held, null); // wait for drops to land
  // boxes: break visible reactors (Pio's boxes) with basic attacks instead of hunting mobs.
  // ponytail: "broken" = state 4 (Amherst box 2001: 0→1→2→4 over three hits); read the template's last state if other reactors differ.
  const pool = goal.boxes ? world.reactors.filter((r) => r.visible && r.state < 4) : world.mobs;
  let target = pool.find((x) => x.id === goal.targetId);
  if (goal.targetId && !target) {
    m.kills++; // our target vanished (killed); ponytail: counts despawns as kills too
    goal.lastKill = Date.now(); // its drop appears a tick or two later
    goal.targetId = null;
  }
  if (!target || Date.now() - goal.targetSince > TARGET_TIMEOUT_MS) {
    const score = (x) => Math.abs(x.x - world.self.x) + 4 * Math.abs(x.y - world.self.y);
    // Timed out chasing it: skip it for a while, not forever. A permanent mark (promoted from Lumen's overlay,
    // 2026-10-05) gave up on every mob after a few slow chases → "no mobs here" with mobs on screen.
    if (goal.targetId && target) (goal.gaveUp ??= {})[goal.targetId] = Date.now();
    // Skip monsters that are too dangerous for us (training.js's model, a bit stricter): > 2 levels above us, or 4 touches
    // (touch ≈ PADamage × 0.5) would take all our max HP. {brave:true} turns this off; a mob filter that
    // names them explicitly also wins.
    const stats = navFor(world.mapId)?.mobs;
    const deadly = (x) => {
      const s = stats?.get(x.templateId);
      return Boolean(s) && (s.level > world.self.level + 2 || s.touch * TOUCH_SCALE * 4 >= world.self.maxHp);
    };
    const recentlyGaveUp = (x) => Date.now() - (goal.gaveUp?.[x.id] ?? 0) < GAVE_UP_MS;
    const candidates = pool.filter((x) => !recentlyGaveUp(x) && !inDanger(world.mapId, x.x, x.y) && (goal.boxes || (goal.mobs?.length ? goal.mobs.includes(x.templateId) : goal.brave || !deadly(x))));
    const sameLevel = candidates.filter((x) => Math.abs(x.y - world.self.y) < LEVEL_DY);
    target = (sameLevel.length ? sameLevel : candidates).sort((a, b) => score(a) - score(b))[0];
    if (!target) {
      steer(held, null);
      if (Date.now() - (goal.idleSince ??= Date.now()) > 15000) endEpisode(m.kills ? "success" : "failed", world, "no mobs here");
      return;
    }
    goal.idleSince = null;
    goal.targetId = target.id;
    goal.targetSince = Date.now();
  }
  const side = target.x >= world.self.x ? 1 : -1;
  let standX = target.x - side * ATTACK_RANGE;
  const floor = world.self.state === "ground" ? navFor(world.mapId)?.at(world.self.x, world.self.y) : null;
  if (floor) standX = Math.min(Math.max(standX, floor.x1 + 12), floor.x2 - 12); // don't walk off the ledge to stand off
  if (Math.abs(target.y - world.self.y) >= LEVEL_DY && world.self.state === "ground" && startNav(world, target)) return;
  if (!approach(held, world, standX, target.y, 12)) return;
  if (Math.abs(target.y - world.self.y) >= LEVEL_DY) {
    // Lined up but on another floor: swinging here hits air. Drop down to it, or ride a ladder up;
    // if neither works the target timeout picks someone reachable.
    steer(held, null);
    if (world.self.state !== "ground" || Date.now() - stuck.lastJump < 800) return;
    if (target.y > world.self.y) {
      stuck.lastJump = Date.now();
      m.drops = (m.drops ?? 0) + 1;
      dropThrough(held);
    } else startClimbToward(world, target.y);
    return;
  }
  if (world.self.facing !== side) {
    steer(held, side > 0 ? "right" : "left"); // sim.facing is ±1; one step toward the mob turns us
    return;
  }
  steer(held, null);
  if (Date.now() - (goal.lastAttack ?? 0) < ATTACK_EVERY_MS) return;
  goal.lastAttack = Date.now();
  m.attacks++;
  if (goal.skill && Date.now() > (goal.meleeUntil ?? 0)) {
    // e.g. 1000 Three Snails (fixed damage). Cast only with the MP for it; a refused cast (MP, cooldown,
    // REQUIREMENTS_NOT_MET) falls back to melee swings for 4 s. (Before: 232 attacks for 12 kills, every one a
    // refused cast at MP 6.)
    const rank = body.transport.progress?.skills?.find((k) => k.id === goal.skill)?.rank ?? 0;
    const cost = gameCatalog?.ui?.skills?.[String(goal.skill)]?.level?.[String(rank)]?.mpCon ?? 0;
    if (rank && world.self.mp >= cost && body.transport.status === "active") {
      m.casts = (m.casts ?? 0) + 1;
      body.transport.command({ kind: "skill.cast", skillId: goal.skill }).then(
        (r) => { m.lastCast = r?.code ?? r?.status; if (m.lastCast !== "OK" && m.lastCast !== "committed") (goal.meleeUntil = Date.now() + 4000), (m.castFails = (m.castFails ?? 0) + 1); },
        (e) => ((m.lastCast = e.code ?? e.message), (goal.meleeUntil = Date.now() + 4000), (m.castFails = (m.castFails ?? 0) + 1)),
      );
      return;
    }
  }
  m.swings = (m.swings ?? 0) + 1;
  held.attack = true;
  setTimeout(() => (held.attack = false), 120);
}

const LOOT_TRIES = 3;
/** Collect every drop on the map: nearest first, changing level by drop/jump, Z-pickup each. */
function lootAll(body, world) {
  const held = body.held;
  const m = episode.metrics;
  goal.tried ??= {};
  const remaining = world.drops.filter((d) => d.state !== "launching" && (goal.tried[d.id] ?? 0) < LOOT_TRIES);
  if (!remaining.length) {
    steer(held, null);
    const left = world.drops.length;
    return endEpisode(left ? "partial" : "success", world, left ? `${left} drop(s) unreachable` : null);
  }
  if (Date.now() - episode.started > 120000) return endEpisode("timeout", world, `${remaining.length} left`);
  const cost = (d) => Math.abs(d.x - world.self.x) + 3 * Math.abs(d.y - world.self.y);
  const drop = remaining.sort((a, b) => cost(a) - cost(b))[0];
  const at = approach(held, world, drop.x, drop.y, 10);
  const level = Math.abs(drop.y - world.self.y) < 40;
  if (at && !level && world.self.state === "ground" && Date.now() - stuck.lastJump > 800) {
    stuck.lastJump = Date.now();
    if (drop.y > world.self.y) dropThrough(held);
    else jump(held);
    goal.tried[drop.id] = (goal.tried[drop.id] ?? 0) + 0.34; // level changes count a little
    return;
  }
  if (!at || !level || Date.now() - (goal.lastPick ?? 0) < 400 || body.transport.status !== "active") return;
  goal.lastPick = Date.now();
  goal.tried[drop.id] = (goal.tried[drop.id] ?? 0) + 1;
  m.pickups = (m.pickups ?? 0) + 1;
  body.transport.command({ kind: "drop.pickup", dropId: drop.id }).then(
    (r) => console.log("[pickup]", r?.code ?? r?.status),
    (e) => console.log("[pickup] error", e.code ?? e.message),
  );
}

/** Walk next to an NPC (by name) and open a conversation. */
function talk(body, world) {
  const npc = world.npcs.find((n) => n.templateId === goal.templateId);
  if (!npc) return endEpisode("failed", world, `${goal.name} is not on this map`);
  if (!approach(body.held, world, npc.x, npc.y, 40)) return;
  if (live.dialogue || live.shop) return endEpisode("success", world);
  // The server acknowledges a click on an NPC with no talk route or eligible quest without
  // opening anything (docs/server/offline-parity.md). That is "nothing for you", not a failure.
  if (goal.result === "OK" && Date.now() - goal.lastOpen > 2500) {
    event({ kind: "npc", npc: goal.name, type: "none", text: "(nothing to say to you right now)" });
    return endEpisode("no-dialogue", world, `${goal.name} has nothing for you right now`);
  }
  if (body.transport.status !== "active" || Date.now() - (goal.lastOpen ?? 0) < 1500) return;
  if ((goal.opens = (goal.opens ?? 0) + 1) > 4) return endEpisode("failed", world, `${goal.name} would not talk (${goal.result})`);
  goal.lastOpen = Date.now();
  body.transport.command({ kind: "npc.open", npcId: npc.id }).then(
    (r) => (goal.result = r?.code ?? r?.status),
    (e) => (goal.result = e.code ?? e.message),
  );
}

const RECOVERY = 1001;
const RESUME_AT = 0.9; // perch/rest/escape resume their goal at this HP fraction

// ---------- survival planner ----------
// Every tick, decide.survive() picks the cheapest SAFE option from this menu (top wins). Tune here.
// Movement options pause the current goal (live.survival) instead of ending it, so a hunt that
// steps back to heal is still the same hunt. Every decision emits {kind:"survive", option, why}.
//   1 prevent     Recovery on the ground below 70% HP with no mob in contact range (12 HP / 5 s, 30 s)
//   2 rope-heal   on a rope: hop off where it's safe (base clear) or climb off the top, cast, come back
//   3 potion      HP/MP potion sized to the need (smallest that covers the gap, else the biggest)
//   4 safe-ground HP < 40% (or < 60% before a hunt engages): stand still on this platform if no monster is
//                 on it, else walk/jump/drop (nav.js) to the nearest mob-free platform and stand still there.
//                 Beats a rope: on the ground Recovery and potions work (and natural regen, once the server has it).
//   5 walk-away   …no clear platform reachable and a mob in contact range: walk away along this floor
//   6 rope        HP < 30% and a rope with a clear base is reachable: hang on it (buys time only)
//   7 portal      HP < 30%, cornered (no platform/rope): leave through the nearest portal, heal, come back
//   8 restock     HP < 50%, no HP potions, Recovery > 60 s away (or critical with no safe ground): shop, come back.
//                 Checked before "already resting", so a long wait on safe ground turns into a shopping trip.
//   9 die         nothing worked: auto-revive in town (costs EXP; counted as a failure in retro)
const SURVIVE = { prevent: 0.7, rest: 0.6, potion: 0.45, danger: 0.4, critical: 0.3, restock: 0.5, mpPotion: 0.2, contact: 110, sameFloor: 50 };

/** Consumables in the bag that restore HP or MP (from the item's catalog spec, not hard-coded ids). */
function potions(body, c, stat) {
  return (body.transport.inventory?.items ?? [])
    .filter((i) => (c?.ui.items[String(i.templateId)]?.spec?.[stat] ?? 0) > 0)
    .sort((a, b) => c.ui.items[String(a.templateId)].spec[stat] - c.ui.items[String(b.templateId)].spec[stat]);
}
/** The smallest potion that covers `missing`, else the biggest one we have. */
function potionFor(body, stat, missing) {
  const list = potions(body, gameCatalog, stat);
  return list.find((i) => gameCatalog.ui.items[String(i.templateId)].spec[stat] >= missing) ?? list.at(-1);
}

function use(body, item, why, world) {
  live.lastVitals = Date.now();
  body.transport.command({ kind: "item.use", itemId: item.id }).then(
    (r) => event({ kind: "reflex", action: why, item: gameCatalog?.ui.items[String(item.templateId)]?.name, hp: world.self.hp, mp: world.self.mp, result: r?.code ?? r?.status }),
    () => {},
  );
}

function nearestLadder(world) {
  // Prefer a rope whose bottom is on my own platform (reachable by walking); others need a nav path.
  // Any rope nav.js can path to counts (drop down / jump / climb to its base) — standing above a rope's top
  // used to filter out the only rope on the map (23:26 death). Without nav: ropes spanning my height only.
  const nav = navFor(world.mapId), here = world.self.state === "ground" ? nav?.at(world.self.x, world.self.y) : null;
  const spans = (l) => world.self.y > l.top && world.self.y <= l.bottom + 90;
  const cost = (l) => {
    if (!here) return spans(l) ? Math.abs(l.x - world.self.x) : Infinity;
    if (nav.at(l.x, l.bottom)?.id === here.id) return Math.abs(l.x - world.self.x);
    const steps = nav.plan(world.self, { x: l.x, y: l.bottom });
    return steps ? 300 * steps.length + Math.abs(l.x - world.self.x) : Infinity;
  };
  return (live.ladders ?? []).map((l) => ({ l, c: cost(l) })).filter((e) => e.c < Infinity).sort((a, b) => a.c - b.c)[0]?.l;
}

const REVIVE_RETRY_MS = 5000;
/** HP 0: say so once, drop the goal (kept in the event for the LLM), ask to return to town (the client's OK button). */
function died(body, world) {
  if (!live.dead) {
    const lost = goal.type === "idle" ? null : { ...goal };
    live.dead = { at: Date.now(), tries: 0 };
    live.survival = null;
    steer(body.held, null);
    body.held.up = false;
    event({ kind: "survive", option: "die", why: `HP 0 on map ${world.mapId}` });
    event({ kind: "died", mapId: world.mapId, x: world.self.x, y: world.self.y, goal: lost?.type ?? null, resume: lost });
    endEpisode("died", world, `died on map ${world.mapId}`);
  }
  const d = live.dead;
  if (body.transport.status !== "active" || Date.now() - (d.lastTry ?? 0) < REVIVE_RETRY_MS || d.tries >= 6) return;
  d.lastTry = Date.now();
  d.tries++; // ponytail: retried every 5 s (the server answered NOT_ALLOWED once right after death), max 6
  body.transport.command({ kind: "revive.request", method: "return" }).then(
    (r) => event({ kind: "reflex", action: "revive", result: r?.code ?? r?.status }),
    (e) => event({ kind: "reflex", action: "revive", result: e.code ?? e.message }),
  );
}

/** Everything the planner looks at, in one place. */
function senses(body, world) {
  const t = body.transport, me = world.self;
  const rec = t.progress?.skills?.find((k) => k.id === RECOVERY && k.rank > 0);
  const stats = navFor(world.mapId)?.mobs;
  const sameFloor = world.mobs.filter((m) => Math.abs(m.y - me.y) < SURVIVE.sameFloor);
  const nearest = sameFloor.sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0] ?? null;
  const hist = (live.hpHist ??= []);
  hist.push({ t: Date.now(), hp: me.hp });
  while (hist.length && Date.now() - hist[0].t > 5000) hist.shift();
  return {
    hp: me.hp / me.maxHp, mp: me.mp / me.maxMp,
    hpDrop5s: Math.max(0, Math.max(...hist.map((h) => h.hp)) - me.hp) / me.maxHp, // HP lost over the last 5 s, fraction of max
    onRope: me.state === "ladder", onGround: me.state === "ground",
    recReady: Boolean(rec) && (rec.cooldownUntil ?? 0) <= Date.now() && me.mp >= 5 * rec.rank,
    recSoon: Boolean(rec) && (rec.cooldownUntil ?? 0) - Date.now() < 20000,
    // seconds until Recovery can be cast: Infinity if unlearned, or if MP is short and there's no MP potion to fix it
    recWait: !rec || (me.mp < 5 * rec.rank && !potions(body, gameCatalog, "mp").length) ? Infinity : Math.max(0, (rec.cooldownUntil ?? 0) - Date.now()) / 1000,
    recovering: (me.effects ?? t.model?.self?.effects ?? []).some((e) => e.templateId === RECOVERY),
    hpPots: count(potions(body, gameCatalog, "hp")), mpPots: count(potions(body, gameCatalog, "mp")), // items, not stacks
    nearest, dist: nearest ? Math.abs(nearest.x - me.x) : Infinity,
    touch: nearest ? (stats?.get(nearest.templateId)?.touch ?? 20) * TOUCH_SCALE : 0,
    resting: goal.type === "perch" || goal.type === "rest" || Boolean(live.survival),
  };
}
/** Nearest platform with no monster on it: {here:true} if mine is clear, else {c, steps} via nav.js, else null. */
function safeGround(world) {
  const nav = navFor(world.mapId);
  if (!nav) return null;
  const me = world.self, here = nav.at(me.x, me.y);
  const clear = (p) => !world.mobs.some((m) => m.x > p.x1 - 60 && m.x < p.x2 + 60 &&
    Math.abs(m.y - (nav.yAt(p, Math.min(Math.max(m.x, p.x1), p.x2)) ?? m.y)) < SURVIVE.sameFloor);
  const safe = (p) => clear(p) && !inDanger(world.mapId, (p.x1 + p.x2) / 2, nav.yAt(p, Math.round((p.x1 + p.x2) / 2)) ?? 0);
  if (here && safe(here) && !inDanger(world.mapId, me.x, me.y)) return { here: true };
  return nav.plats
    .filter((p) => p !== here && p.x2 - p.x1 > 40 && safe(p))
    .map((p) => {
      const x = Math.round((p.x1 + p.x2) / 2), c = { x, y: Math.round(nav.yAt(p, x) ?? 0) };
      const steps = nav.plan(me, c);
      return steps?.length ? { c, steps } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.steps.length - b.steps.length || Math.abs(a.c.x - me.x) - Math.abs(b.c.x - me.x))[0] ?? null;
}
const clearAround = (world, x, y, r = 120) => !world.mobs.some((m) => Math.abs(m.x - x) < r && Math.abs(m.y - y) < SURVIVE.sameFloor + 30);

/** The menu, in order. Returns [option, why, run] for the first option that applies, or null. */
function decide(body, world, s) {
  const me = world.self, held = body.held;
  const pct = (f) => `${Math.round(f * 100)}%`;
  const contact = s.dist < SURVIVE.contact;
  // 1 prevent
  if (s.onGround && s.hp < SURVIVE.prevent && s.recReady && !s.recovering && !contact)
    return ["prevent", `HP ${pct(s.hp)}, Recovery ready, nearest mob ${s.dist === Infinity ? "none" : `${s.dist}px`}`, () => cast(body, RECOVERY, world)];
  // 2 rope-heal
  // Not while riding a rope on purpose (nav/climb sub-goal): hopping off broke nav climbs mid-rope (432,-21);
  // "prevent" casts as soon as we step off at the top. Retreat perches have no goal.climbing, so they still heal here.
  if (s.onRope && s.hp < SURVIVE.prevent && s.recReady && !s.recovering && !goal.climbing) {
    const l = ladderAt(world);
    if (l && clearAround(world, me.x, l.bottom)) return ["rope-heal", "base of the rope is clear: hop off and cast", () => hopOff(body, world)];
    if (l && clearAround(world, me.x, l.top, 160)) return ["rope-heal", "mob below: climb off the top and cast", () => (live.survival = { mode: "rope-top", ladder: l, since: Date.now() })];
    return null; // both ends unsafe: wait on the rope
  }
  // 3 potion
  const hpGap = me.maxHp - me.hp;
  // Falling fast (≥ 15 % of max HP in the last 5 s) with potions: drink before walking anywhere (01:34: 49 → 33 % in 5 s
  // while the planner chose to walk to safe ground with 5 potions in the bag).
  if (s.hpPots && s.hpDrop5s >= 0.15 && s.hp < 0.6)
    return ["potion", `HP falling fast (−${pct(s.hpDrop5s)} in 5 s) at ${pct(s.hp)}`, () => use(body, potionFor(body, "hp", hpGap), "HP potion", world)];
  if (s.hpPots && !s.recovering && (s.hp < SURVIVE.potion || (s.resting && s.hp < RESUME_AT && !s.recSoon)))
    return ["potion", `HP ${pct(s.hp)}${s.recSoon ? "" : ", Recovery not ready"}`, () => use(body, potionFor(body, "hp", hpGap), "HP potion", world)];
  if (s.mpPots && (s.mp < SURVIVE.mpPotion || (s.hp < SURVIVE.prevent && !s.recReady && s.recSoon && me.mp < 15)))
    return ["potion", `MP ${pct(s.mp)}`, () => use(body, potionFor(body, "mp", me.maxMp - me.mp), "MP potion", world)];
  // 8 restock — only when the wait for Recovery is long, or we're critical with nowhere safe to stand.
  // (00:02 death: restocking at 47% HP with Recovery 20 s away meant a 30 s walk through monsters.)
  const spareMesos = (body.transport.inventory?.mesos ?? 0) - Number(goal.keep ?? 0);
  if (s.hp < SURVIVE.restock && !s.hpPots && !s.recReady && !s.recovering && !ERRANDS.has(goal.type) && !contact && !failed("restock") && (spareMesos >= 50 || sellables(body) > 0) &&
      (s.recWait > 60 || (s.hp < SURVIVE.critical && !safeGround(world))))
    return ["restock", `HP ${pct(s.hp)}, no potions, Recovery ${s.recWait === Infinity ? "unlearned" : `${Math.round(s.recWait)} s away`}`,
      () => pauseFor(world, { type: "restock", home: world.mapId, keep: goal.keep ?? 0 })]; // keep: 00:31 this spent the boat fare (306 → 3)
  // 8b restock early: a hunt between targets with fewer than 3 HP potions and the mesos for more.
  const spare = (body.transport.inventory?.mesos ?? 0) - Number(goal.keep ?? 0);
  if (goal.type === "hunt" && !goal.targetId && !goal.boxes && s.hpPots < 3 && spare >= 150 && !contact && !failed("restock"))
    return ["restock", `only ${s.hpPots} HP potions left, ${spare} mesos to spend`, () => pauseFor(world, { type: "restock", home: world.mapId, keep: goal.keep ?? 0 })];
  if (live.survival) return null; // already moving to safety / resting
  // 4 safe ground: low, and can't heal right here (a mob in contact range, or nothing to heal with yet).
  // Runs during every moving goal (hunt, restock, escape, travel, goto, follow), not only hunts.
  // nothing to heal with yet, but it's coming (Recovery soon): wait standing still. Not on a restock walk — that IS the fix.
  const waiting = s.hp < SURVIVE.restock && !s.hpPots && !s.recReady && !s.recovering && s.recWait <= 60 && goal.type !== "restock";
  const zone = inDanger(world.mapId, me.x, me.y);
  const hurtHere = zone && s.hp < (live.zoneHp ?? 1); // took damage inside a danger zone: leave now
  live.zoneHp = zone ? s.hp : 1;
  // Resting only helps if something will heal us (potions, Recovery within 60 s; natural regen once the server has it).
  // 01:00: 0 MP, 0 potions, 23 mesos — resting/perching forever blocked the walk to town. Without a heal source, keep
  // going unless a monster is on us or we're in a danger zone.
  const canHeal = s.hpPots > 0 || s.recWait <= 60 || NATURAL_REGEN;
  const needRest = s.onGround && (canHeal || contact || hurtHere) && (s.hp < SURVIVE.danger || waiting || hurtHere || (s.hp < SURVIVE.rest && goal.type === "hunt" && !goal.targetId));
  if (needRest && goal.type !== "perch" && goal.type !== "talk") {
    const spot = failed("safe-ground") ? null : safeGround(world);
    if (spot?.here) return ["safe-ground", `HP ${pct(s.hp)}: this platform is clear — stand still and heal`, () => (live.survival = { mode: "rest", since: Date.now() })];
    if (spot) return ["safe-ground", `HP ${pct(s.hp)}: ${spot.steps.length}-step path to a clear platform at y≈${spot.c.y}`,
      () => ((goal.nav = { steps: spot.steps, i: 0, stepAt: Date.now() }), (live.survival = { mode: "nav", since: Date.now() }))];
    // 5 walk away along this floor
    if (contact && (s.hp >= SURVIVE.critical || failed("safe-ground")) && !failed("walk-away"))
      return ["walk-away", `mob at ${s.dist}px, no clear platform reachable`, () => (live.survival = { mode: "walk", dir: s.nearest.x > me.x ? -1 : 1, since: Date.now() })];
  }
  if (s.hp < SURVIVE.critical && goal.type !== "perch" && goal.type !== "escape") {
    const l = nearestLadder(world);
    if (l && (canHeal || contact) && !failed("rope") && clearAround(world, l.x, l.bottom) && Math.abs(l.x - me.x) < 500)
      return ["rope", `HP ${pct(s.hp)}, rope at x=${l.x} with a clear base`, () => pauseFor(world, { type: "perch", ladder: l })];
    const exit = (live.exits ?? []).filter((e) => Math.abs(e.y - me.y) < 80).sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
    if (exit && !failed("portal") && !ERRANDS.has(goal.type)) return ["portal", `HP ${pct(s.hp)}, cornered: leave via ${exit.name} (${Math.abs(exit.x - me.x)}px)`, () => pauseFor(world, { type: "escape", via: exit, home: world.mapId })];
  }
  return null;
}

/** End the current goal's episode and run `next`, resuming the old goal afterwards. */
function pauseFor(world, next) {
  live.survival = null;
  const resume = goal.type === "idle" ? null : { ...goal, nav: null, climbing: null };
  endEpisode("retreated", world, `survival: ${next.type}`); // retro.js counts retreated + "survival:" as a pause, not a failure
  startEpisode({ ...next, resumeAfter: resume }, world);
}
function cast(body, skillId, world) {
  live.lastVitals = Date.now();
  body.transport.command({ kind: "skill.cast", skillId }).then(
    (r) => event({ kind: "reflex", action: "Recovery", hp: world.self.hp, result: r?.code ?? r?.status }),
    () => {},
  );
}
function ladderAt(world) {
  return (live.ladders ?? []).find((l) => Math.abs(l.x - world.self.x) < 8 && world.self.y >= l.top - 5 && world.self.y <= l.bottom + 5);
}
function hopOff(body, world) {
  const held = body.held;
  held.up = false;
  steer(held, world.self.facing > 0 ? "right" : "left");
  jump(held);
  setTimeout(() => steer(held, null), 150);
  goal.hoppedAt = Date.now();
}

/** Vitals: death/revive bookkeeping, then the survival menu (throttled), then any survival move in progress. */
function vitals(body, world) {
  const t = body.transport;
  if (world.self.hp <= 0) return died(body, world);
  if (live.dead) (event({ kind: "revived", mapId: world.mapId, hp: world.self.hp }), (live.dead = null));
  if (!gameCatalog) return void catalogNow(); // potion specs come from the catalog
  if (live.dialogue || live.shop || t.status !== "active") return;
  if (Date.now() - (live.lastVitals ?? 0) < 1500) return;
  const s = senses(body, world);
  let pick = decide(body, world, s);
  if (!pick) return;
  // Progress check: a movement option chosen again within 30 s, with HP lower and us still within 60 px of
  // where we chose it last time, did not work here — bar it for 30 s and escalate to the next option.
  // (00:17 death: "safe-ground" picked 4× in 30 s at (780,-278) while HP fell 48% → 0.)
  const me = world.self, last = live.lastMove;
  if (MOVES.has(pick[0]) && last?.option === pick[0] && Date.now() - last.at < 30000 && me.hp < last.hp && Math.hypot(me.x - last.x, me.y - last.y) < 60) {
    (live.failedOptions ??= {})[pick[0]] = Date.now() + 30000;
    live.survival = null;
    event({ kind: "survive", option: pick[0], outcome: "failed", why: `no progress (HP ${last.hp} → ${me.hp}, still at ${me.x},${me.y}); trying the next option` });
    pick = decide(body, world, s);
    if (!pick) return;
  }
  const [option, why, run] = pick;
  live.lastVitals = Date.now();
  if (MOVES.has(option)) live.lastMove = { option, at: Date.now(), hp: me.hp, x: me.x, y: me.y };
  if (live.lastSurvive?.option !== option || Date.now() - live.lastSurvive.at > 5000)
    event({ kind: "survive", option, why, hp: me.hp, hpPots: s.hpPots, recWait: Math.round(s.recWait) });
  live.lastSurvive = { option, at: Date.now() };
  run();
}
// Errands pause a goal; they must not preempt each other (01:00: restock ↔ escape ping-pong every 1.5 s).
const ERRANDS = new Set(["restock", "escape"]);
const NATURAL_REGEN = false; // flip when the online server regenerates HP while standing still (main is adding it)
/** Etc drops and ores we'd sell at a shop (same range trade() sells). */
const sellables = (body) => (body.transport.inventory?.items ?? []).filter((i) => i.templateId >= 4000000 && i.templateId < 4030000).length;
const MOVES = new Set(["safe-ground", "walk-away", "rope", "portal", "restock"]);
const failed = (option) => (live.failedOptions?.[option] ?? 0) > Date.now();

// Places that killed us: don't hunt there, don't rest there, and leave at the first sign of damage.
// Shared with tools and other agents in agent/danger.json ({mapId: [{x1,x2,y1,y2,why}]}), read on
// every brain load — add a zone there, then save brain.js (or wait for the next reload) to pick it up.
let DANGER = {};
try { DANGER = JSON.parse(readFileSync(new URL("./danger.json", import.meta.url), "utf8")); } catch {}
const inDanger = (mapId, x, y) => (DANGER[mapId] ?? []).find((z) => x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2);

/** A survival move in progress pauses the goal; returns true while it is in charge. */
function surviving(body, world) {
  const sv = live.survival;
  if (!sv) return false;
  const held = body.held, me = world.self;
  const stop = () => ((live.survival = null), (held.up = false), steer(held, null), false);
  if (sv.mode === "rest") {
    // Stand perfectly still (natural regen needs it); vitals casts Recovery / drinks meanwhile.
    steer(held, null);
    held.up = false;
    if (me.hp >= me.maxHp * RESUME_AT || Date.now() - sv.since > 120000) return stop();
    if (senses(body, world).dist < SURVIVE.contact) return stop(); // a mob walked up: re-plan
    return true;
  }
  if (Date.now() - sv.since > 15000) return stop();
  if (sv.mode === "walk") {
    steer(held, sv.dir > 0 ? "right" : "left");
    if (Date.now() - sv.since > 1200 || (senses(body, world).dist ?? 0) > 250) (live.survival = null, steer(held, null));
    return true;
  }
  if (sv.mode === "nav") {
    if (!navigating(body, world)) live.survival = { mode: "rest", since: Date.now() }; // arrived (or gave up): rest here
    return true;
  }
  if (sv.mode === "rope-top") {
    // Climb to the top, step off on the side with no mob, then vitals casts Recovery on the floor.
    if (me.state === "ladder") return (steer(held, null), (held.up = true), true);
    if (me.state === "ground" && me.y <= sv.ladder.top + 6) {
      held.up = false;
      if (!sv.stepped) {
        const mobSide = world.mobs.filter((m) => Math.abs(m.y - me.y) < 60).reduce((n, m) => n + Math.sign(m.x - me.x), 0);
        steer(held, mobSide > 0 ? "left" : "right");
        setTimeout(() => steer(held, null), 250);
        sv.stepped = true;
      }
      if (senses(body, world).recovering) live.survival = null; // cast done: the goal (perch) climbs back
      return true;
    }
    return true;
  }
  live.survival = null;
  return false;
}

// ---------- errands that pause a goal: restock (shop) and escape (leave the map, heal, come back) ----------
/** Goal fields worth carrying into a resumed goal (runtime state like targets/nav is dropped). */
const RESUMABLE = ["type", "name", "map", "x", "y", "near", "limit", "plan", "templateId", "mobs", "skill", "brave", "boxes", "ladder", "keep"];
const resumable = (g) => Object.fromEntries(Object.entries(g).filter(([k]) => RESUMABLE.includes(k)));
function finishAndResume(world, outcome, reason) {
  const resume = goal.resumeAfter;
  endEpisode(outcome, world, reason);
  if (!resume) return;
  event({ kind: "resume", goal: resume.type });
  startEpisode(resumable(resume), world);
}

/** Walk the portal route toward mapId (planned async on first call). True once we're there. */
function walkTo(body, world, mapId) {
  if (world.mapId === mapId) return true;
  const key = `${world.mapId}>${mapId}`;
  if (goal.legKey !== key) {
    goal.legKey = key;
    goal.leg = null;
    atlasWorld.route(world.mapId, mapId).then((p) => goal.legKey === key && (goal.leg = p?.steps ?? []), () => {});
  }
  const step = goal.leg?.find((s) => s.map === world.mapId);
  if (!step?.via) return false;
  // Never walk back into a map we escaped from while still hurt (00:59: escape ↔ restock portal ping-pong at 21 HP).
  if (live.escapedFrom === step.via.to && world.self.hp < world.self.maxHp * RESUME_AT) {
    steer(body.held, null);
    if (!live.survival) live.survival = { mode: "rest", since: Date.now() };
    return false;
  }
  if (goal.hop?.map !== world.mapId) goal.hop = freshHop(world.mapId);
  if (usePortal(body, world, step.via, goal.hop)) (goal.legKey = null), (goal.hop = null); // failed: re-plan
  return false;
}

// Potion shops on the beginner path (department stores); the closest by portal hops is used.
const SHOPS = [
  { map: 1000003, npc: 11100 }, // Lucy, Amherst Department Store (Maple Island)
  { map: 104000002, npc: 1001100 }, // Mina, Lith Harbor
  { map: 100000102, npc: 1011100 }, // Luna, Henesys
  { map: 101000002, npc: 1031100 }, // Len the Fairy, Ellinia
];
const RESERVE = { hp: 40, mp: 10 }; // potions to hold after a restock (as many as mesos allow up to this)
const count = (list) => list.reduce((n, i) => n + (i.quantity ?? 1), 0);

/** {type:"restock", keep?:mesos, home?:map}: nearest shop → sell monster drops → buy potions → back → resume. */
function restock(body, world) {
  const held = body.held;
  goal.phase ??= "pick";
  if (Date.now() - episode.started > 300000) return finishAndResume(world, "timeout", `restock stuck in ${goal.phase}`);
  if (goal.phase === "pick") {
    if (!goal.picking) goal.picking = Promise.all(SHOPS.map((s) => atlasWorld.route(world.mapId, s.map).then((p) => ({ s, hops: p?.hops ?? Infinity }), () => ({ s, hops: Infinity }))))
      .then((r) => { const best = r.sort((a, b) => a.hops - b.hops)[0]; goal.shop = best.hops < Infinity ? best.s : null; goal.phase = goal.shop ? "go" : "none"; });
    return steer(held, null);
  }
  if (goal.phase === "none") return finishAndResume(world, "failed", "no shop reachable");
  if (goal.phase === "go") return void (walkTo(body, world, goal.shop.map) && (goal.phase = "talk"));
  if (goal.phase === "talk") {
    if (live.shop) return void (goal.phase = "trade");
    const npc = world.npcs.find((n) => n.templateId === goal.shop.npc);
    if (!npc || !approach(held, world, npc.x, npc.y, 40)) return;
    if (body.transport.status !== "active" || Date.now() - (goal.lastOpen ?? 0) < 2000) return;
    goal.lastOpen = Date.now();
    body.transport.command({ kind: "npc.open", npcId: npc.id }).catch(() => {});
    return;
  }
  if (goal.phase === "trade") {
    goal.trading ??= trade(body, Number(goal.keep ?? 0)).then(
      (summary) => {
        event({ kind: "restocked", ...summary });
        // A trip that bought no HP potion (no spare mesos) must not repeat at once: 5 min cooldown, the
        // planner falls back to rest/Recovery and the hunt earns mesos. (00:45: Lumen bounced town ↔ map.)
        if (!summary.bought.length) (live.failedOptions ??= {}).restock = Date.now() + 300000;
        goal.phase = "back";
      },
      (e) => (event({ kind: "restocked", error: e.code ?? e.message }), (goal.phase = "back")),
    );
    return steer(held, null);
  }
  if (goal.phase === "back") {
    if (goal.home === undefined || walkTo(body, world, Number(goal.home))) finishAndResume(world, "success", "restocked");
  }
}

async function trade(body, keep) {
  const t = body.transport, c = gameCatalog, s = live.shop, sold = [];
  const run = (action) => t.command(action);
  // Monster drops and ores/jewels (etc items 4000000–4029999; quest items are 403xxxx and kept) → mesos.
  // Ores sell for 100–150 mesos each at Lucy (Lumen).
  for (const i of [...(t.inventory?.items ?? [])].filter((i) => i.templateId >= 4000000 && i.templateId < 4030000)) {
    const r = await run({ kind: "shop.sell", shopSession: s.session, itemId: i.id, quantity: i.quantity });
    sold.push(`${c.ui.items[String(i.templateId)]?.name?.trim()} ×${i.quantity}: ${r?.code ?? r?.status}`);
  }
  const bought = [];
  for (const stat of ["hp", "mp"]) {
    // Most restore per meso; Red Potion (50 HP / 50 mesos) usually wins for HP.
    const row = s.rows.filter((r) => (c.ui.items[String(r.itemId)]?.spec?.[stat] ?? 0) > 0)
      .sort((a, b) => c.ui.items[String(b.itemId)].spec[stat] / b.price - c.ui.items[String(a.itemId)].spec[stat] / a.price)[0];
    if (!row) continue;
    const want = RESERVE[stat] - count(potions(body, c, stat));
    const n = Math.min(want, Math.floor(((t.inventory?.mesos ?? 0) - keep) / row.price));
    if (n <= 0) continue;
    const r = await run({ kind: "shop.buy", shopSession: s.session, rowId: row.rowId, quantity: n });
    bought.push(`${row.item} ×${n}: ${r?.code ?? r?.status}`);
  }
  await t.command({ kind: "npc.answer", conversationId: s.session, step: s.revision, answer: { kind: "cancel" } }, s.revision).catch(() => {});
  return { sold, bought, mesos: t.inventory?.mesos ?? null };
}

/** {type:"escape", via:exit, home}: leave through `via`, stand still until healed, walk back, resume. */
function escape(body, world) {
  goal.phase ??= "out";
  if (Date.now() - episode.started > 240000) return finishAndResume(world, "timeout", `escape stuck in ${goal.phase}`);
  if (goal.phase === "out") {
    if (world.mapId !== goal.home) return void ((goal.phase = "heal"), (live.escapedFrom = goal.home));
    if (goal.hop?.map !== world.mapId) goal.hop = freshHop(world.mapId);
    const failure = usePortal(body, world, goal.via, goal.hop);
    if (failure) finishAndResume(world, "failed", failure);
    return;
  }
  if (goal.phase === "heal") {
    steer(body.held, null); // stand still: Recovery / potions (and natural regen) via vitals
    const sv = senses(body, world);
    if (!sv.hpPots && sv.recWait > 60 && !NATURAL_REGEN && !failed("restock")) {
      // Nothing will heal us here: shop now (we're out of danger), then go home and resume.
      const next = { type: "restock", home: goal.home, keep: goal.resumeAfter?.keep ?? 0, resumeAfter: goal.resumeAfter };
      endEpisode("retreated", world, "survival: restock");
      return startEpisode(next, world);
    }
    if (world.self.hp >= world.self.maxHp * RESUME_AT) goal.phase = "back";
    return;
  }
  if (walkTo(body, world, goal.home)) finishAndResume(world, "success", "escaped and healed");
}

/**
 * Perch: get onto the nearest rope/ladder and hang a little above its bottom. Monsters can't
 * touch you on a rope, so this is the safe place to "think" or to recover after a retreat.
 * With goal.resumeAfter (set by vitals), the previous goal resumes at RESUME_AT HP.
 */
function perch(body, world) {
  const held = body.held;
  const { ladder } = goal;
  const onLadder = world.self.state === "ladder";
  // vitals hopped us off the rope to cast Recovery (throttled 1.5 s): stay on the floor until it's cast.
  if (Date.now() - (goal.hoppedAt ?? 0) < 2500) return void (world.self.state === "ground" && steer(body.held, null));
  if (onLadder && goal.resumeAfter && world.self.hp >= world.self.maxHp * RESUME_AT) {
    const resume = goal.resumeAfter;
    held.up = false;
    endEpisode("success", world, "recovered on rope");
    event({ kind: "resume", goal: resume.type });
    startEpisode(resumable(resume), world);
    return;
  }
  if (onLadder) {
    steer(held, null);
    const target = Math.max(ladder.top + 10, ladder.bottom - 40); // safely off the floor
    held.up = world.self.y > target + 4;
    if (!held.up && !goal.perched) {
      goal.perched = true;
      episode.metrics.perchMs = Date.now() - episode.started;
      event({ kind: "perched", x: world.self.x, y: world.self.y });
    }
    return;
  }
  goal.perched = false;
  if (Date.now() - Math.max(episode.started, goal.hoppedAt ?? 0) > 20000) return endEpisode("timeout", world, "could not reach a rope");
  if (navigating(body, world)) return;
  // Rope bottom on another floor: walk a nav.js path to the floor under it first (Wayfinder's suggestion).
  if (world.self.state === "ground" && Math.abs(ladder.bottom - world.self.y) > 40 && Date.now() - (goal.navTry ?? 0) > 1500) {
    goal.navTry = Date.now();
    if (startNav(world, { x: ladder.x, y: ladder.bottom })) return;
  }
  if (Math.abs(world.self.x - ladder.x) <= 4) {
    steer(held, null);
    held.up = true;
    if (ladder.bottom < world.self.y - 10 && Date.now() - stuck.lastJump > 700) (stuck.lastJump = Date.now(), jump(held));
    return;
  }
  held.up = false;
  approach(held, world, ladder.x, world.self.y, 4);
}

function act(body, world) {
  const held = body.held;
  track(world);
  vitals(body, world); // also while perched: hanging on a rope is where Recovery/potions should heal us
  if (surviving(body, world)) return; // a survival move (rest, step to safe ground, climb off a rope top) pauses the goal
  if (goal.type === "restock") return restock(body, world);
  if (goal.type === "escape") return escape(body, world);
  if (goal.type === "perch") return perch(body, world);
  if (goal.type === "talk") return talk(body, world);
  if (goal.type === "loot") return lootAll(body, world);
  if (goal.type === "hunt") return hunt(body, world);
  if (goal.type === "travel") return travel(body, world);
  if (goal.type === "climb") return climb(body, world);
  if (goal.type === "follow") {
    const target = world.players.find((p) => p.name?.toLowerCase() === goal.name.toLowerCase());
    if (!target) {
      const last = goal.lastSeen;
      if (last && last.mapId === world.mapId) {
        // They vanished: assume they took the exit nearest their last position.
        const exit = (live.exits ?? [])
          .map((e) => ({ e, d: Math.hypot(e.x - last.x, e.y - last.y) }))
          .sort((a, b) => a.d - b.d)[0];
        if (exit && exit.d < 150) {
          if (goal.hop?.map !== world.mapId) goal.hop = freshHop(world.mapId);
          const failure = usePortal(body, world, exit.e, goal.hop);
          if (failure) endEpisode("failed", world, `lost ${goal.name}: ${failure}`);
          return;
        }
      }
      steer(held, null);
      const since = Date.now() - (last?.at ?? episode.started);
      if (since > 30000) endEpisode("failed", world, last ? `lost ${goal.name} on map ${last.mapId}` : "target not on this map");
      return;
    }
    goal.lastSeen = { x: target.x, y: target.y, mapId: world.mapId, at: Date.now() };
    const dy = target.y - world.self.y;
    // "Near" = within 150 px, counted on every tick (it used to skip ticks spent navigating/climbing).
    if (Math.hypot(target.x - world.self.x, dy) <= 150) episode.metrics.nearTicks++;
    // Re-path when the target has moved to another platform than the one the current path leads to.
    const nav = navFor(world.mapId), theirs = nav?.at(target.x, target.y)?.id;
    if (goal.nav && theirs !== undefined && goal.navTo !== undefined && theirs !== goal.navTo && !goal.climbing) {
      goal.nav = null;
      goal.navTry = 0;
      episode.metrics.repaths = (episode.metrics.repaths ?? 0) + 1;
    }
    if (navigating(body, world)) return; // platform path (nav.js) to the target's floor
    if (climbing(held, world)) return;
    // Another floor: plan a platform path. Retry at most every 1.5 s (target may be mid-jump/unplannable);
    // the drop/ladder heuristics below are the fallback when nav has no path.
    if (Math.abs(dy) >= LEVEL_DY && world.self.state === "ground" && Date.now() - (goal.navTry ?? 0) > 1500) {
      goal.navTry = Date.now();
      if (startNav(world, target)) return void (goal.navTo = theirs);
    }
    const near = approach(held, world, target.x, target.y);
    if (world.self.state !== "ground" || Date.now() - stuck.lastJump < 800) return;
    if (dy > 40 && Math.abs(target.x - world.self.x) < 120) {
      // Target is below: drop through the platform.
      stuck.lastJump = Date.now();
      episode.metrics.drops = (episode.metrics.drops ?? 0) + 1;
      dropThrough(held);
    } else if (dy < -40) {
      // Target is above: climb a ladder that reaches its level, else try jumping.
      if (startClimbToward(world, target.y)) return;
      if (near) {
        stuck.lastJump = Date.now();
        jump(held);
      }
    }
  } else if (goal.type === "goto") {
    // {type:"goto",x} walks on this floor; with y it first follows a nav.js path to the floor at (x,y).
    if (Date.now() - episode.started > (goal.y === undefined ? 30000 : 60000)) return endEpisode("timeout", world, whyStuck(world, goal));
    if (navigating(body, world)) return;
    const target = { x: Number(goal.x), y: Number(goal.y) };
    const offFloor = goal.y !== undefined && world.self.state === "ground" && Math.abs(target.y - world.self.y) >= LEVEL_DY;
    if (offFloor && startNav(world, target)) return;
    if (offFloor && navFor(world.mapId) && !navFor(world.mapId).plan(world.self, target))
      return endEpisode("failed", world, `no nav path from ${world.self.x},${world.self.y} to the floor at ${target.x},${target.y}`);
    // {near}: arrival tolerance in px (default NEAR_X); e.g. near:4 to stand on a script portal before portal.enter.
    if (approach(held, world, target.x, world.self.y, Number(goal.near ?? NEAR_X)) && !offFloor) endEpisode("success", world);
  } else {
    steer(held, null);
  }
}

// ---------- events for the LLM ----------
let known = null;
function noticeChanges(world) {
  const names = new Set(world.players.map((p) => p.name));
  if (known) {
    for (const n of names) if (!known.players.has(n)) event({ kind: "player-arrived", name: n });
    for (const n of known.players) if (!names.has(n)) event({ kind: "player-left", name: n });
    if (world.mapId !== known.mapId) event({ kind: "map", mapId: world.mapId });
    if (world.self.hp < known.hp * 0.7) event({ kind: "hurt", hp: world.self.hp, maxHp: world.self.maxHp });
    if (world.self.level > known.level)
      event({ kind: "level-up", level: world.self.level, ap: world.self.ap, note: "spend AP/skill points: GET /character, then POST /goal {type:\"command\",action:{kind:\"stats.allocate\"|\"skills.allocate\",...}}" });
  }
  known = { players: names, mapId: world.mapId, hp: world.self.hp, level: world.self.level };
}

// ---------- NPC conversations: readable turns for the LLM ----------
let gameCatalog = null;
const catalogNow = async () => (gameCatalog ??= await atlasWorld.catalog());
const questName = (c, id) => c.quests.records[String(id)]?.name ?? `quest ${id}`;

/** MapleStory dialogue markup -> plain text. #L<n>#label#l becomes "[n] label". */
function readable(text, c, me) {
  const name = (table, id) => c.quests.strings[table]?.[String(Number(id))] ?? `#${id}`;
  return text
    .replace(/#L(\d+)#/g, "\n[$1] ")
    .replace(/#l/g, "")
    .replace(/#h(?:0| )?#/g, me)
    .replace(/#[pP](\d+):?#/g, (_, id) => name("npc", id))
    .replace(/#[oO](\d+):?#/g, (_, id) => name("mob", id))
    .replace(/#[tTzZ](\d+):?#/g, (_, id) => c.ui.items[String(Number(id))]?.name?.trim() ?? name("item", id))
    .replace(/#[iI](\d+):?#/g, "")
    .replace(/#[mM](\d+):?#/g, (_, id) => c.mapNames[Number(id)] ?? `map ${id}`)
    .replace(/#[cvauy](\d+):?#/g, "$1")
    .replace(/#[fF][^#\r\n]+#/g, "")
    .replace(/#@\d+:#/g, "")
    .replace(/#[bgrdken]/g, "")
    .replace(/##/g, "#")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Turn a dialogue event into one event-log record the LLM can act on. */
async function hearDialogue(ev) {
  const c = await catalogNow();
  let text = ev.text;
  if (text === undefined) {
    const r = await fetch(`/api/v1/content/${ev.contentId}`);
    text = r.ok ? (await r.json()).text ?? "" : "";
  }
  const plain = readable(text ?? "", c, opts.name);
  const turn = {
    kind: "npc",
    npc: c.quests.strings.npc[String(ev.npcTemplateId)] ?? `npc ${ev.npcTemplateId}`,
    type: ev.native.kind, // say | yes-no | accept-decline | choice | number | text
    text: plain,
    choices: ev.choices,
    canNext: ev.native.next,
    canPrev: ev.native.prev,
    ...(ev.quest
      ? { quest: { id: ev.quest.questId, name: questName(c, ev.quest.questId), mode: ev.quest.mode, stage: ev.quest.stage,
          rewardChoices: ev.quest.rewardChoices.map((r) => ({ index: r.index, item: c.ui.items[String(r.id)]?.name?.trim() ?? r.id, count: r.count })) } }
      : {}),
    reply: "POST /goal {type:\"reply\", answer: next|yes|no|choose|close, value?}",
  };
  live.dialogue = ev;
  event(turn);
}

/** A shop arrives in parts of ≤128 rows (server/src/interaction-shop.js); announce it once whole. */
async function hearShop(ev) {
  const c = await catalogNow();
  const rows = ev.part === 0 || live.shop?.session !== ev.shopSession ? [] : live.shop.rows;
  for (const r of ev.rows)
    rows.push({ rowId: r.rowId, itemId: r.templateId, item: c.ui.items[String(r.templateId)]?.name?.trim() ?? r.templateId, price: r.unitPrice });
  live.shop = { session: ev.shopSession, revision: ev.revision, npcId: ev.npcTemplateId, rows };
  if (ev.part + 1 < ev.parts) return;
  const npc = c.quests.strings.npc[String(ev.npcTemplateId)] ?? `npc ${ev.npcTemplateId}`;
  event({ kind: "npc", npc, type: "shop", rows, mesos: live.body?.transport.inventory?.mesos ?? null,
    reply: "POST /goal {type:\"shop\", action: buy|sell|close, rowId? (buy), item? (sell: inventory uid or name), quantity?}" });
}

// ---------- map context: static map knowledge + live state, relative to me ----------
async function mapContext(live) {
  const ctx = await world.context(live.mapId);
  const me = live.self;
  const rel = (o) => {
    const dx = Math.round(o.x - me.x), dy = Math.round(o.y - me.y);
    const side = Math.abs(dx) < 30 ? "here" : dx > 0 ? "right" : "left";
    const level = Math.abs(dy) < 40 ? "same level" : dy < 0 ? "above" : "below";
    return { ...o, dx, dy, where: `${Math.abs(dx)}px ${side}, ${level}` };
  };
  return {
    map: `${ctx.name} (${ctx.mapId})`,
    me,
    players: live.players.map(rel),
    npcs: ctx.npcs.map(rel),
    exits: ctx.exits.map(rel),
    mobsHere: live.mobs.length,
    mobTypes: ctx.mobs,
    ladders: ctx.ladders,
    platformHeights: ctx.platformHeights,
  };
}

// ---------- hot-reload state handoff ----------
export function snapshot() {
  return { goal, episode, stuck: { ...stuck }, known, gameCatalog };
}
export function restore(s) {
  if (!s) return;
  goal = s.goal ?? goal;
  episode = s.episode ?? episode;
  Object.assign(stuck, s.stuck ?? {});
  known = s.known ?? known;
  gameCatalog = s.gameCatalog ?? gameCatalog;
}

// ---------- body hooks ----------
export { perceive, endEpisode };
export function tick(body, worldNow) {
  noticeChanges(worldNow);
  act(body, worldNow);
}
export function onEvent(ev) {
  if (ev.kind === "dialogue") hearDialogue(ev).catch((e) => console.log("[dialogue]", e.message));
  if (ev.kind === "shop") hearShop(ev).catch((e) => console.log("[shop]", e.message));
  if (ev.kind === "dialogue.closed") {
    if (live.shop?.session === ev.conversationId) live.shop = null;
    live.dialogue = null;
    event({ kind: "npc-closed" });
  }
  if (ev.kind === "chat" && ev.senderName !== opts.name)
    event({ kind: "chat", from: ev.senderName, text: ev.text, channel: ev.channel });
}

// ---------- HTTP goal API ----------
export async function handle(req) {
  const url = new URL(req.url);
  const body = live.body;
  if (req.method === "GET" && url.pathname === "/context") {
    if (!live.world) return Response.json({ ok: false, error: "not in world yet" }, { status: 503 });
    return Response.json(await mapContext(live.world));
  }
  if (req.method === "GET" && url.pathname === "/character") {
    if (!body) return Response.json({ ok: false, error: "offline" }, { status: 503 });
    const t = body.transport, c = await catalogNow(), self = t.model?.self;
    const skillName = (id) => c.ui?.skills?.[String(id)]?.name ?? c.quests.strings.skill?.[String(id)] ?? null;
    const skills = (t.progress?.skills ?? []).map((k) => ({ id: k.id, name: skillName(k.id), rank: k.rank, cooldownUntil: k.cooldownUntil }));
    const beginnerRanks = skills.filter((k) => [1000, 1001, 1002].includes(k.id)).reduce((n, k) => n + k.rank, 0);
    const items = (t.inventory?.items ?? []).map((i) => ({ uid: i.id, templateId: i.templateId, name: c.ui.items[String(i.templateId)]?.name?.trim(),
      // Wire items carry location {kind, slot}; worn gear is kind "equipped" (equipping it again → REQUIREMENTS_NOT_MET).
      equipped: i.location?.kind === "equipped", location: i.location?.kind, slot: i.location?.slot, quantity: i.quantity }));
    return Response.json({
      level: self?.level, job: self?.job, ap: self?.ap, sp: self?.sp, stats: self?.stats, hp: self?.hp, maxHp: self?.maxHp, mp: self?.mp, maxMp: self?.maxMp,
      beginnerSkillPoints: self?.job % 1000 < 100 ? Math.min((self?.level ?? 1) - 1, 6) - beginnerRanks : null,
      skills, effects: self?.effects ?? [], inventory: items, mesos: t.inventory?.mesos,
    });
  }
  if (req.method === "GET" && url.pathname === "/state")
    return Response.json({ online: Boolean(body), transport: body?.transport.status ?? null, goal, version: VERSION, world: live.world,
      episode: { type: episode?.goal?.type ?? goal.type, metrics: episode?.metrics ?? {} } }); // live counters (kills, attacks…) for benches
  if (req.method !== "POST" || url.pathname !== "/goal") return new Response("not found", { status: 404 });
  if (!body) return Response.json({ ok: false, error: "offline (reconnecting)" }, { status: 503 });
  const g = await req.json();
  try {
    if (g.type === "say") {
      const result = await body.transport.command({ kind: "chat.send", channel: "map", text: String(g.text).slice(0, 2000) }); // fork chatText bound (shared/schema.js)
      return Response.json({ ok: true, result: result?.status ?? result });
    }
    if (g.type === "jump") {
      jump(body.held);
      return Response.json({ ok: true });
    }
    if (g.type === "crouch") {
      body.held.down = true;
      setTimeout(() => (body.held.down = false), Math.min(Number(g.ms) || 800, 10000));
      return Response.json({ ok: true });
    }
    if (g.type === "perch") {
      const ctx = await world.context(live.world.mapId);
      const me = live.world.self;
      const ladder = ctx.ladders
        .filter((l) => me.y > l.top && me.y <= l.bottom + 90)
        .sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
      if (!ladder) return Response.json({ ok: false, error: "no rope or ladder reachable from this level" }, { status: 400 });
      startEpisode({ type: "perch", ladder }, live.world);
      return Response.json({ ok: true, ladder });
    }
    if (g.type === "climb") {
      const ctx = await world.context(live.world.mapId);
      const me = live.world.self;
      const ladder = ctx.ladders
        .filter((l) => me.y > l.top && me.y <= l.bottom + 90) // +90: reachable by jump-grab
        .sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
      if (!ladder) return Response.json({ ok: false, error: "no ladder reachable from here" }, { status: 400 });
      startEpisode({ type: "climb", ladder }, live.world);
      return Response.json({ ok: true, ladder });
    }
    if (g.type === "travel") {
      const plan = await world.route(live.world.mapId, g.map);
      if (!plan) return Response.json({ ok: false, error: `no route to map ${g.map}` }, { status: 400 });
      startEpisode({ type: "travel", map: Number(g.map), plan: plan.steps }, live.world);
      return Response.json({ ok: true, route: plan.steps.map((s) => `${s.name} via ${s.via?.name}`) });
    }
    if (g.type === "talk") {
      const c = await catalogNow();
      const want = String(g.npc ?? "").toLowerCase();
      const here = live.world.npcs.find((n) => c.quests.strings.npc[String(n.templateId)]?.toLowerCase() === want);
      if (!here) return Response.json({ ok: false, error: `no NPC named ${g.npc} on this map` }, { status: 400 });
      startEpisode({ type: "talk", name: g.npc, templateId: here.templateId }, live.world);
      return Response.json({ ok: true, goal });
    }
    if (g.type === "shop") {
      const s = live.shop;
      if (!s) return Response.json({ ok: false, error: "no open shop (talk to a shop NPC first)" }, { status: 400 });
      let action;
      if (g.action === "close") {
        action = { kind: "npc.answer", conversationId: s.session, step: s.revision, answer: { kind: "cancel" } };
      } else if (g.action === "buy") {
        if (!s.rows.some((r) => r.rowId === Number(g.rowId))) return Response.json({ ok: false, error: "unknown rowId", rows: s.rows }, { status: 400 });
        action = { kind: "shop.buy", shopSession: s.session, rowId: Number(g.rowId), quantity: Number(g.quantity ?? 1) };
      } else if (g.action === "sell") {
        const c = await catalogNow(), want = String(g.item ?? "").toLowerCase();
        const item = (body.transport.inventory?.items ?? []).find((i) =>
          i.location?.kind !== "equipped" && // never sell what you're wearing by name
          (i.id === g.item || c.ui.items[String(i.templateId)]?.name?.trim().toLowerCase() === want));
        if (!item) return Response.json({ ok: false, error: `no inventory item ${g.item}` }, { status: 400 });
        action = { kind: "shop.sell", shopSession: s.session, itemId: item.id, quantity: Number(g.quantity ?? item.quantity) };
      } else return Response.json({ ok: false, error: "action: buy|sell|close" }, { status: 400 });
      // shop.buy/sell are inventory-domain commands: the server checks the inventory revision (transport default);
      // passing the shop's step there was answered STALE_REVISION. Only the npc.answer close uses the step.
      const result = await body.transport.command(action, g.action === "close" ? s.revision : undefined);
      const code = result?.code ?? result?.status ?? result;
      event({ kind: "shop-result", action: g.action, rowId: action.rowId, itemId: action.itemId, quantity: action.quantity, result: code,
        mesos: body.transport.inventory?.mesos ?? null });
      return Response.json({ ok: code === "OK", result: code, mesos: body.transport.inventory?.mesos ?? null });
    }
    if (g.type === "reply") {
      const d = live.dialogue;
      if (!d) return Response.json({ ok: false, error: "no open conversation" }, { status: 400 });
      const a = String(g.answer);
      let action;
      // Browser rule (native-dialogue.js commandFor): on a quest confirm screen, accept or a final
      // acknowledge (say box with no next page) sends quest.accept / quest.claim.
      if (d.quest?.mode === "confirm" && ["yes", "accept", "next"].includes(a) && (d.native.kind !== "say" || !d.native.next)) {
        action = { kind: `quest.${d.quest.stage === 0 ? "accept" : "claim"}`, questId: d.quest.questId, conversationId: d.conversationId, step: d.step,
          ...(g.value !== undefined ? { rewardChoice: Number(g.value) } : {}) };
      } else {
        const answer = a === "next" ? { kind: "next" } : a === "previous" ? { kind: "previous" } : a === "close" ? { kind: "cancel" }
          : a === "yes" || a === "accept" ? { kind: "yesno", value: true } : a === "no" || a === "decline" ? { kind: "yesno", value: false }
          : a === "choose" ? { kind: "choice", choiceId: Number(g.value) } : a === "number" || a === "text" ? { kind: a, value: g.value } : null;
        if (!answer) return Response.json({ ok: false, error: "answer: next|previous|yes|no|choose|number|text|close" }, { status: 400 });
        action = { kind: "npc.answer", conversationId: d.conversationId, step: d.step, answer };
      }
      const result = await body.transport.command(action, action.kind === "npc.answer" ? d.step : undefined);
      return Response.json({ ok: true, sent: action.kind, result: result?.code ?? result?.status ?? result });
    }
    // Raw game action for the LLM layer, admitted by the same server rules as the browser:
    // {kind:"stats.allocate",stat,amount} {kind:"skills.allocate",skillId,amount}
    // {kind:"skill.cast",skillId} {kind:"equipment.equip",itemId,slot} ...
    if (g.type === "command") {
      const result = await body.transport.command(g.action);
      event({ kind: "command", action: g.action, result: result?.code ?? result?.status });
      return Response.json({ ok: true, result: result?.code ?? result?.status ?? result });
    }
    if (g.type === "hunt") {
      // mob: template id or name, or a list of them — only those are targeted (quest kills).
      const strings = (await catalogNow()).quests.strings.mob ?? {};
      const mobs = [g.mob ?? []].flat().map((m) => /^\d+$/.test(String(m)) ? Number(m)
        : Number(Object.entries(strings).find(([, n]) => n.toLowerCase() === String(m).toLowerCase())?.[0]));
      if (mobs.some((m) => !m)) return Response.json({ ok: false, error: `unknown mob in ${JSON.stringify(g.mob)}` }, { status: 400 });
      startEpisode({ type: "hunt", limit: Number(g.limit) || 0, skill: g.boxes ? 0 : Number(g.skill) || 0, mobs, boxes: Boolean(g.boxes), brave: Boolean(g.brave), keep: Number(g.keep ?? 0) }, live.world);
      return Response.json({ ok: true, goal });
    }
    if (g.type === "loot") {
      startEpisode({ type: "loot", seen: live.world.drops.length }, live.world);
      return Response.json({ ok: true, drops: live.world.drops.length });
    }
    if (g.type === "restock") {
      startEpisode({ type: "restock", keep: Number(g.keep ?? 0), home: g.home ?? live.world.mapId }, live.world);
      return Response.json({ ok: true, goal });
    }
    if (!["follow", "goto", "idle", "stop"].includes(g.type))
      return Response.json({ ok: false, error: "unknown goal" }, { status: 400 });
    startEpisode(g.type === "stop" ? { type: "idle" } : g, live.world);
    return Response.json({ ok: true, goal });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

