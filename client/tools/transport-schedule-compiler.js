import { integerLiteral, parseNpcSource } from "./npc-script-ir.js";

/**
 * Closed reader for the vendored transport event shape (Boats, Trains, Subway,
 * Cabin, Genie, AirPlane): init binds maps and scales times, scheduleNew docks and
 * opens entry, a stop callback closes entry, takeoff warps waiting rooms onto the
 * ride maps, arrived warps rides to their stations and reopens the cycle. Source is
 * parsed, never evaluated. Members with no server consumer (ship presentation,
 * cabin clearing, random Balrog invasion) are listed in `unsupported`.
 */
const MAX_MAPS = 16;
const MAX_STATEMENTS = 64;
const CALLBACKS = ["init", "scheduleNew", "takeoff", "arrived"];
const PRESENTATION = new Map([
  ["setDocked", "ship-presentation"],
  ["broadcastShip", "ship-presentation"],
  ["broadcastEnemyShip", "ship-presentation"],
  ["clearMapObjects", "field-object-clearing"],
  ["killAllMonsters", "field-monster-clearing"],
]);

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
        if (declaration.init && /Time$/.test(declaration.id.name)) {
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

/** takeoff: `if (Math.random() < p) em.schedule("approach", …)` (Balrog invasion). */
function randomBranch(state, node) {
  const random = memberCall(node.test?.left);
  need(
    node.test?.type === "BinaryExpression" &&
      isIdentifier(random?.receiver, "Math") &&
      random.method === "random" &&
      !node.alternate,
    node,
    "Unsupported transport branch",
  );
  state.unsupported.add("random-invasion");
  return { kind: "ignored" };
}

/** One recognized statement of a transport callback. */
function statement(state, node) {
  if (node.type === "IfStatement") return randomBranch(state, node);
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

function mapCall(state, call, node) {
  if (PRESENTATION.has(call.method)) {
    state.unsupported.add(PRESENTATION.get(call.method));
    return { kind: "ignored" };
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
  return node.body.body.map((child) => statement(state, child));
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
  const time = (name) => ({
    ms: state.times.get(name),
    scaled: state.scaled.has(name),
  });
  return {
    closeTime: time(opening.stop.time),
    beginTime: time(opening.takeoff.time),
    rideTime: time(rides[0].time),
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
      unsupported: new Set(),
    };
    const bodies = {};
    for (const name of CALLBACKS) bodies[name] = callback(state, name);
    const schedule = cycle(state, bodies);
    return {
      ...result,
      status: "supported",
      blockers: [],
      ...schedule,
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
