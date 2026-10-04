// Hot-reloadable agent behaviors: perception, goals, reflexes, NPC dialogue, map context and the
// HTTP goal API. agent.js (the body) keeps the socket and re-imports this file when it is saved,
// carrying goal/episode/state across via snapshot()/restore() — edit behaviors without a restart.
// Bound by attach(): opts, log, event, live (body-owned state), VERSION, atlasWorld/world.
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
  if (Date.now() - hop.started > HOP_TIMEOUT_MS) return `could not reach portal ${via.name}`;
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
  body.transport.command({ kind: "portal.enter", portalId: via.portalId }).then(
    (r) => ((ep.lastPortal = r?.code ?? r?.status ?? r), console.log("[portal]", JSON.stringify(r))),
    (e) => ((ep.lastPortal = e.code ?? e.message), console.log("[portal] error", e.code ?? e.message)),
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
    if (!onLadder && sub.bottom < world.self.y - 10 && Date.now() - stuck.lastJump > 700) (stuck.lastJump = Date.now(), jump(held));
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

const ATTACK_RANGE = 45; // stand-off from the target, px
const ATTACK_EVERY_MS = 650;
const TARGET_TIMEOUT_MS = 20000;
const LEVEL_DY = 40; // same floor: attacks only connect when the mob is within this vertical distance

/** Hunt: nearest mob (same level first), stand off facing it, tap attack. Server resolves damage. */
function hunt(body, world) {
  const held = body.held;
  const m = episode.metrics;
  m.attacks ??= 0; m.kills ??= 0;
  episode.startExp ??= world.self.exp;
  m.expGained = (world.self.exp ?? 0) - (episode.startExp ?? 0);
  if (world.self.hp < world.self.maxHp * 0.3) {
    steer(held, null);
    return endEpisode("stopped", world, `low HP ${world.self.hp}/${world.self.maxHp}`);
  }
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
  let target = world.mobs.find((x) => x.id === goal.targetId);
  if (goal.targetId && !target) {
    m.kills++; // our target vanished (killed); ponytail: counts despawns as kills too
    goal.lastKill = Date.now(); // its drop appears a tick or two later
    goal.targetId = null;
  }
  if (!target || Date.now() - goal.targetSince > TARGET_TIMEOUT_MS) {
    const score = (x) => Math.abs(x.x - world.self.x) + 4 * Math.abs(x.y - world.self.y);
    if (goal.targetId && target) (goal.gaveUp ??= {})[goal.targetId] = true; // timed out: unreachable
    const candidates = world.mobs.filter((x) => !goal.gaveUp?.[x.id]);
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
  const standX = target.x - side * ATTACK_RANGE;
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
  if (goal.skill) {
    // e.g. 1000 Three Snails: fixed damage, uses a Snail Shell per throw.
    if (body.transport.status !== "active") return;
    body.transport.command({ kind: "skill.cast", skillId: goal.skill }).then(
      (r) => (m.lastCast = r?.code ?? r?.status),
      (e) => (m.lastCast = e.code ?? e.message),
    );
    return;
  }
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
  if (live.dialogue) return endEpisode("success", world);
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
const HEAL_AT = 0.7; // Recovery below 70% HP
const POTION_AT = 0.45; // HP potion below 45% when Recovery is unavailable
const RETREAT_AT = 0.3; // nothing left: hang on a rope until HP recovers
const RESUME_AT = 0.9;
const MP_POTION_AT = 0.2;

/** Consumables in the bag that restore HP or MP (from the item's catalog spec, not hard-coded ids). */
function potions(body, c, stat) {
  return (body.transport.inventory?.items ?? [])
    .filter((i) => (c?.ui.items[String(i.templateId)]?.spec?.[stat] ?? 0) > 0)
    .sort((a, b) => c.ui.items[String(a.templateId)].spec[stat] - c.ui.items[String(b.templateId)].spec[stat]);
}

function use(body, item, why, world) {
  live.lastVitals = Date.now();
  body.transport.command({ kind: "item.use", itemId: item.id }).then(
    (r) => event({ kind: "reflex", action: why, item: gameCatalog?.ui.items[String(item.templateId)]?.name, hp: world.self.hp, mp: world.self.mp, result: r?.code ?? r?.status }),
    () => {},
  );
}

function nearestLadder(world) {
  return (live.ladders ?? [])
    .filter((l) => world.self.y > l.top && world.self.y <= l.bottom + 90)
    .sort((a, b) => Math.abs(a.x - world.self.x) - Math.abs(b.x - world.self.x))[0];
}

/**
 * Vitals loop, every tick and independent of the goal: HP/MP thresholds escalate from
 * Recovery to potions to retreating onto a rope (monsters can't reach you there).
 */
function vitals(body, world) {
  const t = body.transport;
  if (live.dialogue || t.status !== "active" || Date.now() - (live.lastVitals ?? 0) < 1500) return;
  const hp = world.self.hp / world.self.maxHp, mp = world.self.mp / world.self.maxMp;
  const recovery = t.progress?.skills?.find((k) => k.id === RECOVERY && k.rank > 0);
  const recoveryReady = recovery && (recovery.cooldownUntil ?? 0) <= Date.now() && world.self.mp >= 5 * recovery.rank;
  const recovering = (world.self.effects ?? t.model?.self?.effects ?? []).some((e) => e.templateId === RECOVERY);
  if (mp < MP_POTION_AT) {
    const mpPot = potions(body, gameCatalog, "mp")[0];
    if (mpPot) return use(body, mpPot, "MP potion", world);
  }
  if (hp < HEAL_AT && recoveryReady && !recovering) {
    live.lastVitals = Date.now();
    return t.command({ kind: "skill.cast", skillId: RECOVERY }).then(
      (r) => event({ kind: "reflex", action: "Recovery", hp: world.self.hp, result: r?.code ?? r?.status }),
      () => {},
    );
  }
  if (hp < POTION_AT && !recovering) {
    const hpPot = potions(body, gameCatalog, "hp")[0];
    if (hpPot) return use(body, hpPot, "HP potion", world);
  }
  if (hp < RETREAT_AT && goal.type !== "perch") {
    const ladder = nearestLadder(world);
    const resume = goal.type === "idle" ? null : { ...goal };
    live.lastVitals = Date.now();
    event({ kind: "retreat", hp: world.self.hp, maxHp: world.self.maxHp, to: ladder ? `rope at x=${ladder.x}` : "nowhere (no rope)", resume: resume?.type ?? null });
    endEpisode("retreated", world, `HP ${world.self.hp}/${world.self.maxHp}`);
    if (ladder) startEpisode({ type: "perch", ladder, resumeAfter: resume }, world);
  }
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
  if (onLadder && goal.resumeAfter && world.self.hp >= world.self.maxHp * RESUME_AT) {
    const resume = goal.resumeAfter;
    held.up = false;
    endEpisode("success", world, "recovered on rope");
    event({ kind: "resume", goal: resume.type });
    const keep = ["name", "map", "x", "limit", "plan", "templateId"];
    startEpisode({ type: resume.type, ...Object.fromEntries(Object.entries(resume).filter(([k]) => keep.includes(k))) }, world);
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
  if (Date.now() - episode.started > 20000) return endEpisode("timeout", world, "could not reach a rope");
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
  if (goal.type === "perch") return perch(body, world);
  vitals(body, world);
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
    if (climbing(held, world)) return;
    const dy = target.y - world.self.y;
    const near = approach(held, world, target.x, target.y);
    if (near && Math.abs(dy) < 40) episode.metrics.nearTicks++;
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
    if (approach(held, world, goal.x, world.self.y)) endEpisode("success", world);
    else if (Date.now() - episode.started > 30000) endEpisode("timeout", world);
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
  if (ev.kind === "dialogue.closed") (live.dialogue = null), event({ kind: "npc-closed" });
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
    const items = (t.inventory?.items ?? []).map((i) => ({ uid: i.id, templateId: i.templateId, name: c.ui.items[String(i.templateId)]?.name?.trim(), tab: i.tab, slot: i.slot, quantity: i.quantity }));
    return Response.json({
      level: self?.level, job: self?.job, ap: self?.ap, sp: self?.sp, stats: self?.stats, hp: self?.hp, maxHp: self?.maxHp, mp: self?.mp, maxMp: self?.maxMp,
      beginnerSkillPoints: self?.job % 1000 < 100 ? Math.min((self?.level ?? 1) - 1, 6) - beginnerRanks : null,
      skills, effects: self?.effects ?? [], inventory: items, mesos: t.inventory?.mesos,
    });
  }
  if (req.method === "GET" && url.pathname === "/state")
    return Response.json({ online: Boolean(body), transport: body?.transport.status ?? null, goal, version: VERSION, world: live.world });
  if (req.method !== "POST" || url.pathname !== "/goal") return new Response("not found", { status: 404 });
  if (!body) return Response.json({ ok: false, error: "offline (reconnecting)" }, { status: 503 });
  const g = await req.json();
  try {
    if (g.type === "say") {
      const result = await body.transport.command({ kind: "chat.send", channel: "map", text: String(g.text).slice(0, 200) }); // fork client CHAT_LIMIT
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
      startEpisode({ type: "hunt", limit: Number(g.limit) || 0, skill: Number(g.skill) || 0 }, live.world);
      return Response.json({ ok: true, goal });
    }
    if (g.type === "loot") {
      startEpisode({ type: "loot", seen: live.world.drops.length }, live.world);
      return Response.json({ ok: true, drops: live.world.drops.length });
    }
    if (!["follow", "goto", "idle", "stop"].includes(g.type))
      return Response.json({ ok: false, error: "unknown goal" }, { status: 400 });
    startEpisode(g.type === "stop" ? { type: "idle" } : g, live.world);
    return Response.json({ ok: true, goal });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

