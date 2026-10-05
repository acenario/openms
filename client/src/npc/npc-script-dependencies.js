import {
  NPC_READ_TYPES,
  NPC_RUNTIME_LIMITS as LIMITS,
  npcInteger,
  requireNpc,
} from "./npc-script-values.js";
import { SAVED_LOCATION_TYPES } from "../profile/profile-domains.js";

function assignments(program) {
  const values = new Map(),
    mutated = new Set();
  for (const node of program.statements) {
    const entries =
      node.op === "declare"
        ? node.values
        : node.op === "assign" && node.operator === "="
          ? [node]
          : [];
    for (const entry of entries) {
      rememberHelperAssignment(values, entry.name, entry.value);
    }
    if (
      node.op === "update" ||
      (node.op === "assign" && node.operator !== "=")
    ) {
      mutated.add(node.name);
    }
    if (node.op === "for") mutated.add(node.variable);
  }
  helperAssignments(program, values);
  return { values, mutated };
}

function helperAssignments(program, values) {
  for (const node of program.expressions) {
    if (node.op === "helper-set") {
      rememberHelperAssignment(values, node.name, node.value);
    }
    if (node.op !== "helper") continue;
    for (let index = 0; index < node.args.length; index++) {
      rememberHelperAssignment(values, node.bindings[index], node.args[index]);
    }
  }
}

function rememberHelperAssignment(values, name, expression) {
  if (!values.has(name)) values.set(name, []);
  values.get(name).push(expression);
}

function expandVariable(state, node, analysis) {
  const values = analysis.assignments.values.get(node.name);
  requireNpc(
    values?.length && !analysis.assignments.mutated.has(node.name),
    "NPC dependency uses an unbounded variable",
    "npc-dependency",
  );
  for (const expression of values) {
    analysis.queue.push({ expression, path: state.path });
  }
}

function expandIndex(state, node, analysis) {
  const index = analysis.context.program.expressions[node.index];
  const value =
    index.op === "literal" && Number.isSafeInteger(index.value)
      ? index.value
      : "all";
  requireNpc(
    state.path.length < LIMITS.depth,
    "NPC dependency index depth exceeded",
    "npc-dependency",
  );
  analysis.queue.push({ expression: node.value, path: [value, ...state.path] });
}

function expandArray(state, node, analysis) {
  const index = state.path.length ? state.path[0] : "all",
    path = state.path.slice(1);
  if (index === "all") {
    for (const expression of node.values) {
      analysis.queue.push({ expression, path });
    }
  } else {
    requireNpc(
      index >= 0 && index < node.values.length,
      "NPC dependency index is out of range",
      "npc-dependency",
    );
    analysis.queue.push({ expression: node.values[index], path });
  }
}

function expand(state, node, analysis) {
  switch (node.op) {
    case "variable":
    case "helper-value":
      expandVariable(state, node, analysis);
      break;
    case "helper":
    case "helper-set":
      analysis.queue.push({ expression: node.body, path: state.path });
      break;
    case "index":
      expandIndex(state, node, analysis);
      break;
    case "conditional":
      analysis.queue.push(
        { expression: node.yes, path: state.path },
        { expression: node.no, path: state.path },
      );
      break;
    case "array":
      expandArray(state, node, analysis);
      break;
    case "literal":
      requireNpc(
        state.path.every((part) => part === "all"),
        "NPC scalar dependency has an invalid index",
        "npc-dependency",
      );
      analysis.queue.push({ expression: state.expression, path: [] });
      break;
    default:
      requireNpc(
        false,
        "NPC dependency is not a complete finite literal set",
        "npc-dependency",
      );
  }
}

/** Mirror the compiler's finite literal/array/alias proof, independently of published ID lists. */
function finiteValues(analysis, expression, arrays = false, family = null) {
  analysis.queue = [{ expression, path: [] }];
  const seen = new Set(),
    result = new Set();
  for (let index = 0; index < analysis.queue.length; index++) {
    requireNpc(
      ++analysis.steps <= LIMITS.analysisSteps &&
        analysis.queue.length <= LIMITS.nodes,
      "NPC dependency analysis budget exceeded",
      "npc-dependency",
    );
    const state = analysis.queue[index],
      key = `${state.expression}:${state.path.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = analysis.context.program.expressions[state.expression];
    collectFiniteValue(analysis, { state, node, arrays, family }, result);
  }
  requireNpc(
    result.size > 0,
    "NPC dependency has no literal values",
    "npc-dependency",
  );
  return result;
}

function collectFiniteValue(analysis, item, result) {
  const { state, node, arrays, family } = item;
  if (state.path.length !== 0) {
    expand(state, node, analysis);
    return;
  }
  if (
    family === "mapIds" &&
    node.op === "read" &&
    ["saved-location-peek", "saved-location-take"].includes(node.kind)
  ) {
    result.add("saved-location");
    return;
  }
  if (arrays && node.op === "literal") return;
  if (arrays ? node.op === "array" : node.op === "literal") {
    result.add(arrays ? node.values.length : npcInteger(node.value, 1));
  } else {
    expand(state, node, analysis);
  }
}

function ids(analysis, family, expression) {
  const result = finiteValues(analysis, expression, false, family);
  for (const id of result) {
    if (id === "saved-location") continue;
    requireNpc(
      analysis.context.dependencies[family].has(id),
      `NPC ${family} closure omitted an executable source ID`,
      "npc-dependency",
    );
  }
  return result;
}

function negativeLiteral(program, expression) {
  const node = program.expressions[expression];
  if (node?.op === "literal") {
    return typeof node.value === "number" && node.value < 0;
  }
  if (node?.op !== "unary" || node.operator !== "-") return false;
  const child = program.expressions[node.value];
  return (
    child.op === "literal" && typeof child.value === "number" && child.value > 0
  );
}

function effectDependencies(analysis, node) {
  if (node.kind === "save-location") {
    validateSavedType(analysis.context, node);
    return;
  }
  if (
    ["meso", "crafting-scroll", "job", "reset-stats", "portal-sound"].includes(
      node.kind,
    )
  ) {
    return;
  }
  if (node.kind === "warp") {
    ids(analysis, "mapIds", node.args[0]);
    return;
  }
  const family = node.kind === "item" ? "itemIds" : "questIds";
  const values = ids(analysis, family, node.args[0]);
  if (node.kind !== "item") {
    for (const id of values) analysis.context.forceQuestIds.add(id);
    if (node.args.length === 2) ids(analysis, "npcIds", node.args[1]);
    return;
  }
  itemEffectDependencies(analysis, node, values);
}

function itemEffectDependencies(analysis, node, values) {
  const grant =
    node.overload === "id-show" ||
    node.args.length === 1 ||
    !negativeLiteral(analysis.context.program, node.args[1]);
  for (const id of values) {
    requireNpc(
      !grant || Math.trunc(id / 1000) !== 5000,
      "NPC item grant requires pet instance authority",
      "npc-dependency",
    );
    if (grant && Math.trunc(id / 1000000) === 1) {
      requireNpc(
        analysis.context.requirements.has(
          "equipment-grants:original-template-no-enhanced-crafting",
        ),
        "Missing NPC equipment creation policy",
      );
    }
  }
  const showIndex =
    node.overload === "id-show" ? 1 : node.args.length === 3 ? 2 : -1;
  if (showIndex >= 0) {
    const show = analysis.context.program.expressions[node.args[showIndex]];
    requireNpc(
      show.op === "literal" && typeof show.value === "boolean",
      "NPC item show flag is not a literal boolean",
    );
  }
}

function validateSavedType(context, node) {
  requireNpc(
    context.requirements.has("saved-location-authority"),
    "Missing saved location authority",
  );
  const type = context.program.expressions[node.args[0]];
  requireNpc(
    node.args.length === 1 &&
      type?.op === "literal" &&
      SAVED_LOCATION_TYPES.includes(type.value),
    "Invalid native saved location type",
  );
  if (node.kind === "saved-location-take") {
    requireNpc(
      context.requirements.has("atomic-local-turn"),
      "Saved location consumption requires a transaction",
    );
    context.hasEffects = true;
  }
}
export function validateNpcReferences(context) {
  const program = context.program;
  const analysis = {
    context,
    assignments: assignments(program),
    steps: 0,
    queue: [],
  };
  context.forceQuestIds = new Set();
  for (const node of program.expressions) {
    if (node.op !== "read") continue;
    if (["saved-location-peek", "saved-location-take"].includes(node.kind)) {
      validateSavedType(context, node);
    }
    const family = NPC_READ_TYPES[node.kind][2];
    if (family) ids(analysis, family, node.args[0]);
  }
  for (const node of program.statements) {
    if (node.op === "effect") effectDependencies(analysis, node);
    if (node.op !== "for") continue;
    const outer = program.expressions[node.test];
    const test =
      outer.op === "logical" && outer.operator === "&&"
        ? program.expressions[outer.right]
        : outer;
    const bound = program.expressions[test.right];
    if (bound.op === "length") finiteValues(analysis, bound.value, true);
  }
}
