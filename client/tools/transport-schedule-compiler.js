import { integerLiteral, parseNpcSource } from "./npc-script-ir.js";

/**
 * Closed reader for the vendored transport event shape (Boats, Trains, Subway,
 * Cabin, Genie, AirPlane): init binds maps and scales times, scheduleNew docks and
 * opens entry, a stop callback closes entry, takeoff warps waiting rooms onto the
 * ride maps, arrived warps rides to their stations and reopens the cycle. Source is
 * parsed, never evaluated. The Boats random invasion (takeoff's random approach →
 * approach → invasion spawns, cleared by arrived's killAllMonsters) is published as
 * `invasion`. Members with no server consumer (ship presentation, music, cabin
 * clearing) are listed in `unsupported`.
 */
const MAX_MAPS = 16;
const MAX_STATEMENTS = 64;
const MAX_SPAWNS = 16;
const CALLBACKS = ["init", "scheduleNew", "takeoff", "arrived"];
const PRESENTATION = new Map([
  ["setDocked", "ship-presentation"],
  ["broadcastShip", "ship-presentation"],
  ["broadcastEnemyShip", "ship-presentation"],
  ["clearMapObjects", "field-object-clearing"],
]);
const JAVA_TYPES = new Set(["tools.PacketCreator", "server.life.LifeFactory"]);

function fail(node, message) {
  const error = new Error(message);
  error.loc = node?.loc?.start;
  error.pos = node?.start;
  throw error;
}

function isIdentifier(node, name) {
  return (
    node?.type === "Identifier" && (name === undefined || node.name === name)
  );
}

function memberCall(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed
  ) {
    return null;
  }
  return {
    receiver: node.callee.object,
    method: node.callee.property.name,
    args: node.arguments,
  };
}

/** `4 * 60 * 1000`: integer literals joined by `*`, nothing else. */
function constantTime(node) {
  const pending = [node];
  let product = 1;
  for (let steps = 0; pending.length; steps++) {
    if (steps > 16) fail(node, "Transport time expression is too large");
    const next = pending.pop();
    if (next.type === "BinaryExpression" && next.operator === "*") {
      pending.push(next.left, next.right);
      continue;
    }
    const value = integerLiteral(next);
    if (value === null || value < 0) {
      fail(next, "Transport time must be a product of integer literals");
    }
    product *= value;
  }
  if (!Number.isSafeInteger(product) || product <= 0) {
    fail(node, "Transport time is out of range");
  }
  return product;
}

function topLevel(root) {
  const times = new Map(),
    functions = new Map();
  for (const node of root.body) {
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        // Boats' invasionDelay is the one authored time without the Time suffix.
        if (declaration.init && /(Time|Delay)$/.test(declaration.id.name)) {
          times.set(declaration.id.name, constantTime(declaration.init));
        }
      }
    } else if (node.type === "FunctionDeclaration") {
      functions.set(node.id.name, node);
    }
  }
  return { times, functions };
}

function stringArgs(call, count) {
  if (
    call.args.length !== count ||
    call.args.some(
      (arg) => arg.type !== "Literal" || typeof arg.value !== "string",
    )
  ) {
    return null;
  }
  return call.args.map((arg) => arg.value);
}

function need(condition, node, message) {
  if (!condition) fail(node, message);
}

/** `Math.<method>(…)`, or null. */
function mathCall(node, method) {
  const call = memberCall(node);
  return isIdentifier(call?.receiver, "Math") && call.method === method
    ? call
    : null;
}

/** `Math.random()` with no arguments. */
function isRandom(node) {
  return mathCall(node, "random")?.args.length === 0;
}

/**
 * `if (Math.random() < p) {…}` or `if (Math.floor(Math.random() * n) < k) {…}`
 * without else: the branch probability, p or min(k, n) / n.
 */
function randomChance(node) {
  const test = node.test;
  need(
    binary(test, "<") &&
      typeof test.right.value === "number" &&
      !node.alternate &&
      node.consequent.type === "BlockStatement",
    node,
    "Unsupported transport branch",
  );
  const limit = test.right.value;
  if (isRandom(test.left)) {
    need(limit > 0 && limit <= 1, node, "Transport chance out of range");
    return limit;
  }
  const floor = mathCall(test.left, "floor");
  const range = floor?.args.length === 1 ? randomRange(floor.args[0]) : null;
  need(
    range > 0 && Number.isSafeInteger(limit) && limit > 0,
    node,
    "Unsupported transport branch",
  );
  return Math.min(limit, range) / range;
}

function binary(node, operator) {
  return node?.type === "BinaryExpression" && node.operator === operator;
}

/** `Math.random() * n` for an integer literal n, or null. */
function randomRange(node) {
  return binary(node, "*") && isRandom(node.left)
    ? integerLiteral(node.right)
    : null;
}

/** The name of an authored time variable, or null. */
function timeName(state, node) {
  return isIdentifier(node) && state.times.has(node.name) ? node.name : null;
}

/** `A + Math.trunc(Math.random() * B)` for authored times A and B, or null. */
function jitteredTime(state, node) {
  const trunc = binary(node, "+") ? mathCall(node.right, "trunc") : null;
  const jitter = trunc?.args.length === 1 ? trunc.args[0] : null;
  const base = trunc && timeName(state, node.left);
  return base && binary(jitter, "*") && isRandom(jitter.left)
    ? { base, jitter: timeName(state, jitter.right) }
    : null;
}

/** takeoff: `if (Math.random() < p) em.schedule(name, A + Math.trunc(Math.random() * B))`. */
function randomBranch(state, node) {
  const chance = randomChance(node);
  const [first, ...rest] = node.consequent.body;
  const call = memberCall(first?.expression);
  const [name, delay] = call?.args ?? [];
  need(
    !rest.length &&
      isIdentifier(call?.receiver, "em") &&
      call.method === "schedule" &&
      call.args.length === 2 &&
      typeof name.value === "string",
    node,
    "Unsupported transport branch",
  );
  const times = jitteredTime(state, delay);
  need(times?.jitter, node, "Unsupported random transport time");
  return { kind: "random-schedule", chance, name: name.value, ...times };
}

function isPoint(node) {
  const callee = node?.callee;
  return (
    node.type === "NewExpression" &&
    callee.type === "MemberExpression" &&
    callee.property.name === "Point" &&
    callee.object.property?.name === "awt" &&
    isIdentifier(callee.object.object, "java") &&
    node.arguments.length === 2
  );
}

/** `const X = Java.type("…")`, `var m = <bound map>`, `var p = new java.awt.Point(x, y)`. */
function declaration(state, node) {
  const [{ id, init }, ...more] = node.declarations;
  const fresh = (name) =>
    ![state.maps, state.locals, state.times].some((names) => names.has(name));
  need(
    !more.length && isIdentifier(id) && init && fresh(id.name),
    node,
    "Unsupported declaration",
  );
  const call = memberCall(init);
  if (isIdentifier(call?.receiver, "Java") && call.method === "type") {
    const [type] = stringArgs(call, 1) ?? [];
    need(JAVA_TYPES.has(type), node, `Unsupported Java type: ${type}`);
    state.locals.set(id.name, { java: type });
  } else if (isIdentifier(init) && state.maps.has(init.name)) {
    state.maps.set(id.name, state.maps.get(init.name));
  } else {
    need(isPoint(init), node, "Unsupported declaration");
    const [x, y] = init.arguments.map(integerLiteral);
    need(x !== null && y !== null, node, "Point must be integer literals");
    state.locals.set(id.name, { point: { x, y } });
  }
  return { kind: "ignored" };
}

/** `X.method(…)` where X was declared `Java.type(type)`, or null. */
function javaCall(state, node, type, method) {
  const call = memberCall(node);
  return isIdentifier(call?.receiver) &&
    state.locals.get(call.receiver.name)?.java === type &&
    call.method === method
    ? call
    : null;
}

/** One recognized statement of a transport callback. */
function statement(state, node) {
  if (node.type === "IfStatement") return randomBranch(state, node);
  if (node.type === "VariableDeclaration") return declaration(state, node);
  need(node.type === "ExpressionStatement", node, "Unsupported statement");
  const expression = node.expression;
  if (expression.type === "AssignmentExpression") {
    need(expression.operator === "=", node, "Unsupported assignment");
    return assignment(state, expression);
  }
  if (expression.type === "CallExpression" && isIdentifier(expression.callee)) {
    need(!expression.arguments.length, node, "Callback arguments unsupported");
    return { kind: "call", name: expression.callee.name };
  }
  const call = memberCall(expression);
  need(call, node, "Unsupported transport expression");
  if (isIdentifier(call.receiver, "em")) return eventCall(state, call, node);
  need(
    isIdentifier(call.receiver) && state.maps.has(call.receiver.name),
    node,
    `Unsupported transport call: ${call.method}`,
  );
  return mapCall(state, call, node);
}

/** `X = em.getTransportationTime(X)` for one authored time variable. */
function timeScaling(state, name, call) {
  return (
    state.times.has(name) &&
    isIdentifier(call?.receiver, "em") &&
    call.method === "getTransportationTime" &&
    call.args.length === 1 &&
    isIdentifier(call.args[0], name)
  );
}

/** `X = em.getChannelServer().getMapFactory().getMap(N)`. */
function mapBinding(call) {
  const factory = memberCall(call?.receiver);
  const channel = memberCall(factory?.receiver);
  return (
    call?.method === "getMap" &&
    call.args.length === 1 &&
    factory?.method === "getMapFactory" &&
    channel?.method === "getChannelServer" &&
    isIdentifier(channel.receiver, "em")
  );
}

function assignment(state, node) {
  need(isIdentifier(node.left), node, "Unsupported transport assignment");
  const name = node.left.name;
  const call = memberCall(node.right);
  if (timeScaling(state, name, call)) {
    state.scaled.add(name);
    return { kind: "ignored" };
  }
  need(mapBinding(call), node, "Unsupported transport assignment");
  const id = integerLiteral(call.args[0]);
  need(
    id !== null && id > 0 && state.maps.size < MAX_MAPS,
    node,
    "Transport map must be a bounded integer literal",
  );
  state.maps.set(name, id);
  return { kind: "ignored" };
}

function eventCall(state, call, node) {
  if (call.method === "setProperty") {
    const args = stringArgs(call, 2);
    need(args, node, "Event property must be two string literals");
    return { kind: "property", key: args[0], value: args[1] };
  }
  const name = call.args[0]?.value;
  const time = call.args[1];
  need(
    call.method === "schedule" &&
      call.args.length === 2 &&
      typeof name === "string" &&
      isIdentifier(time) &&
      state.times.has(time.name),
    node,
    `Unsupported event manager call: em.${call.method}`,
  );
  return { kind: "schedule", name, time: time.name };
}

/** `B.getId()` for a bound transport map. */
function boundMap(state, node) {
  const target = memberCall(node);
  need(
    target?.method === "getId" &&
      !target.args.length &&
      isIdentifier(target.receiver) &&
      state.maps.has(target.receiver.name),
    node,
    "warpEveryone target must be a bound transport map",
  );
  return state.maps.get(target.receiver.name);
}

/** arrived: `M.killAllMonsters()`. */
function clearCall(state, call, node) {
  need(!call.args.length, node, "killAllMonsters takes no arguments");
  return { kind: "clear", mapId: state.maps.get(call.receiver.name) };
}

/** approach: `M.broadcastMessage(PacketCreator.musicChange("…"))`, presentation only. */
function musicCall(state, call, node) {
  const music = javaCall(
    state,
    call.args[0],
    "tools.PacketCreator",
    "musicChange",
  );
  need(
    call.args.length === 1 && music && stringArgs(music, 1),
    node,
    "Unsupported transport broadcast",
  );
  state.unsupported.add("music-change");
  return { kind: "ignored" };
}

/** invasion: `M.spawnMonsterOnGroundBelow(LifeFactory.getMonster(N), point)`. */
function spawnCall(state, call, node) {
  const [mob, at] = call.args;
  const monster = javaCall(state, mob, "server.life.LifeFactory", "getMonster");
  const mobId = monster?.args.length === 1 && integerLiteral(monster.args[0]);
  const point = isIdentifier(at) ? state.locals.get(at.name)?.point : null;
  need(
    call.args.length === 2 && mobId > 0 && point,
    node,
    "Unsupported transport spawn",
  );
  const mapId = state.maps.get(call.receiver.name);
  return { kind: "spawn", mapId, mobId, ...point };
}

const MAP_CALLS = new Map([
  ["killAllMonsters", clearCall],
  ["broadcastMessage", musicCall],
  ["spawnMonsterOnGroundBelow", spawnCall],
]);

function mapCall(state, call, node) {
  if (PRESENTATION.has(call.method)) {
    state.unsupported.add(PRESENTATION.get(call.method));
    return { kind: "ignored" };
  }
  if (MAP_CALLS.has(call.method)) {
    return MAP_CALLS.get(call.method)(state, call, node);
  }
  need(
    call.method === "warpEveryone" && [1, 2].includes(call.args.length),
    node,
    `Unsupported transport map call: ${call.method}`,
  );
  const to = boundMap(state, call.args[0]);
  const from = state.maps.get(call.receiver.name);
  // MapleMap.warpEveryone(to) → changeMap(to) → getRandomPlayerSpawnpoint().
  if (call.args.length === 1) {
    return { kind: "warp", from, to, randomSpawn: true };
  }
  const portal = integerLiteral(call.args[1]);
  need(portal !== null && portal >= 0, node, "warpEveryone portal literal");
  return { kind: "warp", from, to, portal };
}

function callback(state, name) {
  const node = state.functions.get(name);
  need(node && !node.params.length, state.root, `${name}() is required`);
  need(node.body.body.length <= MAX_STATEMENTS, node, "Callback too long");
  state.locals = new Map();
  return node.body.body.map((child) => statement(state, child));
}

function time(state, name) {
  return { ms: state.times.get(name), scaled: state.scaled.has(name) };
}

/**
 * Boats: takeoff's random branch schedules approach, whose random branch
 * schedules invasion, which spawns monsters on ride maps that arrived's
 * killAllMonsters clears. Returns the authored, unscaled invasion, or null.
 */
function invasion(state, bodies) {
  const [branch, ...extra] = only(bodies.takeoff, "random-schedule");
  if (!branch) return null;
  need(!extra.length, state.root, "One random transport branch is supported");
  const approach = state.functions.get(branch.name);
  const inner = approach?.body.body[0];
  need(
    !approach?.params.length &&
      approach.body.body.length === 1 &&
      inner.type === "IfStatement",
    state.root,
    `${branch.name}() must be one random branch`,
  );
  const approachChance = randomChance(inner);
  state.locals = new Map();
  const steps = inner.consequent.body.map((child) => statement(state, child));
  const [next, ...more] = only(steps, "schedule");
  need(
    next && !more.length && !only(steps, "random-schedule").length,
    inner,
    `${branch.name}() must schedule exactly one spawn callback`,
  );
  const body = callback(state, next.name);
  const spawns = only(body, "spawn");
  const rides = new Set(only(bodies.takeoff, "warp").map((warp) => warp.to));
  const clears = new Set(only(bodies.arrived, "clear").map((row) => row.mapId));
  need(
    spawns.length &&
      spawns.length <= MAX_SPAWNS &&
      body.every((row) => row.kind === "ignored" || row.kind === "spawn") &&
      spawns.every((row) => rides.has(row.mapId) && clears.has(row.mapId)),
    state.root,
    `${next.name}() must only spawn on ride maps cleared on arrival`,
  );
  return {
    chance: branch.chance,
    approachChance,
    approachTime: time(state, branch.base),
    approachJitter: time(state, branch.jitter),
    spawnDelay: time(state, next.time),
    spawns: spawns.map(({ mapId, mobId, x, y }) => ({ mapId, mobId, x, y })),
  };
}

function only(list, kind) {
  return list.filter((entry) => entry.kind === kind);
}

function property(list, key) {
  const set = only(list, "property").filter((entry) => entry.key === key);
  return set.length === 1 ? set[0].value : null;
}

function calls(list, name) {
  return only(list, "call").some((entry) => entry.name === name);
}

function warps(list) {
  return only(list, "warp").map(({ from, to, randomSpawn, portal }) =>
    randomSpawn ? { from, to, randomSpawn } : { from, to, portal },
  );
}

/** scheduleNew docks, opens entry and schedules exactly stop + takeoff. */
function openSchedules(state, open) {
  const opens = only(open, "schedule");
  const takeoff = opens.find((entry) => entry.name === "takeoff");
  const stop = opens.find((entry) => entry.name !== "takeoff");
  need(
    opens.length === 2 &&
      takeoff &&
      stop &&
      property(open, "docked") === "true" &&
      property(open, "entry") === "true",
    state.root,
    "scheduleNew is not the canonical transport opening",
  );
  const close = callback(state, stop.name);
  need(
    property(close, "entry") === "false" && !only(close, "schedule").length,
    state.root,
    "Transport stop callback must only close entry",
  );
  // Entry must close before takeoff under every travel rate (ceil is monotone).
  need(
    state.scaled.has(stop.time) === state.scaled.has(takeoff.time) &&
      state.times.get(stop.time) <= state.times.get(takeoff.time),
    state.root,
    "Transport entry must close no later than takeoff",
  );
  return { stop, takeoff };
}

/** Verify the one canonical cycle and return its authored, unscaled schedule. */
function cycle(state, bodies) {
  const [init, open, takeoff, arrived] = CALLBACKS.map((name) => bodies[name]);
  const opening = openSchedules(state, open);
  const rides = only(takeoff, "schedule");
  need(
    calls(init, "scheduleNew") &&
      property(takeoff, "docked") === "false" &&
      rides.length === 1 &&
      rides[0].name === "arrived" &&
      calls(arrived, "scheduleNew"),
    state.root,
    "Event source is not the canonical transport cycle",
  );
  const departures = warps(takeoff);
  const arrivals = warps(arrived);
  need(
    departures.length && arrivals.length,
    state.root,
    "Transport cycle must warp on takeoff and arrival",
  );
  return {
    closeTime: time(state, opening.stop.time),
    beginTime: time(state, opening.takeoff.time),
    rideTime: time(state, rides[0].time),
    departures,
    arrivals,
  };
}

export function compileTransportSchedule({ text, path, sha256 }) {
  const result = { schemaVersion: 1, source: { path, sha256 } };
  try {
    const root = parseNpcSource(text);
    const { times, functions } = topLevel(root);
    const state = {
      root,
      times,
      functions,
      maps: new Map(),
      scaled: new Set(),
      locals: new Map(),
      unsupported: new Set(),
    };
    const bodies = {};
    for (const name of CALLBACKS) bodies[name] = callback(state, name);
    const schedule = cycle(state, bodies);
    const raid = invasion(state, bodies);
    // Only arrived's killAllMonsters has a consumer: it removes the invasion.
    if (
      CALLBACKS.some(
        (name) =>
          (name !== "arrived" || !raid) && only(bodies[name], "clear").length,
      )
    ) {
      state.unsupported.add("field-monster-clearing");
    }
    return {
      ...result,
      status: "supported",
      blockers: [],
      ...schedule,
      ...(raid && { invasion: raid }),
      mapIds: [...new Set(state.maps.values())].sort((a, b) => a - b),
      unsupported: [...state.unsupported].sort(),
    };
  } catch (error) {
    return {
      ...result,
      status: "blocked",
      blockers: [
        {
          source: path,
          line: error.loc?.line ?? 1,
          column: error.loc?.column ?? 0,
          reason: error.message,
        },
      ],
    };
  }
}
