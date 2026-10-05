import {
  npcBooleanConfig,
  npcServiceExpression,
} from "./npc-script-services.js";
import {
  NPC_SCRIPT_LIMITS,
  addDependency,
  blockScript,
  call,
  cmMethod,
  resolveVariable,
  sourceSpan,
  playerMethod,
  spendAnalysisStep,
  textDependencies,
} from "./npc-script-ir.js";
import {
  NPC_MARKUP_FAMILIES,
  NPC_MARKUP_TOKENS,
  npcMarkupId,
} from "../src/npc/npc-script-markup.js";
import { SAVED_LOCATION_TYPES } from "../src/profile/profile-domains.js";
import { npcNumericDomain } from "../src/npc/npc-script-domains.js";

const BINARY = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
]);
const UNARY = new Set(["!", "+", "-", "typeof"]);
const READS = Object.freeze({
  getMeso: ["meso", 0, 0],
  getLevel: ["level", 0, 0],
  getJobId: ["job", 0, 0],
  getJob: ["job", 0, 0],
  getFirstJobStatRequirement: ["first-job-stat-requirement", 1, 1],
  canGetFirstJob: ["can-get-first-job", 1, 1],
  getText: ["input-text", 0, 0],
  getQuestStatus: ["quest-state", 1, 1, "questIds"],
  isQuestCompleted: ["quest-completed", 1, 1, "questIds"],
  isQuestStarted: ["quest-started", 1, 1, "questIds"],
  isQuestActive: ["quest-started", 1, 1, "questIds"],
  itemQuantity: ["item-count", 1, 1, "itemIds"],
  haveItem: ["have-item", 1, 2, "itemIds"],
  canHold: ["can-hold", 1, 2, "itemIds"],
  canHoldAll: ["can-hold-all", 1, 2, "itemIds"],
  canSpawnPlayerNpc: ["can-spawn-player-npc", 1, 1],
});
// Server job enum constant names (Cosmic client/Job.java interface evidence).
// ponytail: only the name an imported script compares; add others when one does.
const JOB_ENUM_IDS = Object.freeze({ BEGINNER: 0 });

function expressionChildren(node) {
  switch (node.type) {
    case "NpcHelperExpression":
      return [...node.args, node.body];
    case "NpcHelperSet":
      return [node.value, node.body];
    case "BinaryExpression":
      return binaryChildren(node);
    case "ArrayExpression":
      return node.elements;
    case "LogicalExpression":
      return [node.left, node.right];
    case "UnaryExpression":
      return [node.argument];
    case "ConditionalExpression":
      return [node.test, node.consequent, node.alternate];
    case "MemberExpression":
      return node.computed ? [node.object, node.property] : [node.object];
    case "CallExpression":
      return node.arguments;
    default:
      return [];
  }
}

/** Array is a type marker, not a variable dependency, in the supported instanceof form. */
function binaryChildren(node) {
  if (
    node.operator === "instanceof" &&
    node.right.type === "Identifier" &&
    node.right.name === "Array"
  ) {
    return [node.left];
  }
  return [node.left, node.right];
}

function allowedLiteral(node) {
  if (node.regex || node.bigint) return false;
  if (node.value === null || typeof node.value === "boolean") return true;
  if (typeof node.value === "number") return Number.isSafeInteger(node.value);
  return (
    typeof node.value === "string" &&
    node.value.length <= NPC_SCRIPT_LIMITS.textLength
  );
}

function literal(context, node) {
  if (!allowedLiteral(node)) {
    blockScript(
      context,
      node,
      "Only bounded strings, safe integers, booleans and null are literal values",
    );
    return null;
  }
  textDependencies(context, node);
  return {
    op: "literal",
    value: node.value,
    raw: context.text.slice(node.start, node.end),
  };
}

function localRead(context, node, refs) {
  const native = nativeRead(context, node, refs) ?? craftingRead(node);
  if (native) return native;
  const method = cmMethod(node),
    spec = Object.hasOwn(READS, method) ? READS[method] : null;
  if (!spec || refs.length < spec[1] || refs.length > spec[2]) {
    blockScript(
      context,
      node,
      `Unsupported expression call: ${method ?? context.text.slice(node.callee.start, node.callee.end)}`,
    );
    return null;
  }
  if (spec[3]) {
    context.dependencyRequests.push({
      kind: spec[3],
      expression: refs[0],
      node,
    });
  }
  if (method === "canGetFirstJob") {
    const value = npcBooleanConfig(context, "USE_AUTOASSIGN_STARTERS_AP");
    refs.push(context.expressions.length);
    context.expressions.push({
      op: "literal",
      value,
      raw: String(value),
      source: sourceSpan(node),
    });
  }
  return { op: "read", kind: spec[0], args: refs };
}

function craftingRead(node) {
  if (call(node, "getCS") && node.arguments.length === 0) {
    const player = node.callee.object;
    if (cmMethod(player) === "getPlayer" && player.arguments.length === 0) {
      return { op: "read", kind: "crafting-scroll", args: [] };
    }
  }
  return null;
}

function nativeRead(context, node, refs) {
  const method = playerMethod(node);
  const scalar = scalarRead(node, refs, method);
  if (scalar) return scalar;
  if (
    (method === "getMapId" || cmMethod(node) === "getMapId") &&
    refs.length === 0
  ) {
    return { op: "read", kind: "map-id", args: [] };
  }
  if (
    call(node, "getId") &&
    refs.length === 0 &&
    playerMethod(node.callee.object) === "getMap" &&
    node.callee.object.arguments.length === 0
  ) {
    return { op: "read", kind: "map-id", args: [] };
  }
  if (cmMethod(node) === "numberWithCommas" && refs.length === 1) {
    return { op: "read", kind: "number-with-commas", args: refs };
  }
  return savedLocationRead(context, node, refs, method);
}

function scalarRead(node, refs, method) {
  if (
    node.callee?.type === "Identifier" &&
    node.callee.name === "parseInt" &&
    refs.length >= 1 &&
    refs.length <= 2
  ) {
    return { op: "read", kind: "parse-int", args: refs };
  }
  if (["getJobId", "getJob"].includes(method) && refs.length === 0) {
    return { op: "read", kind: "job", args: [] };
  }
  return null;
}

function savedLocationRead(context, node, refs, method) {
  if (!["getSavedLocation", "peekSavedLocation"].includes(method)) return null;
  if (
    refs.length !== 1 ||
    !SAVED_LOCATION_TYPES.includes(node.arguments[0]?.value)
  ) {
    blockScript(
      context,
      node,
      "Saved location read requires one literal native location type",
    );
    return { op: "unsupported" };
  }
  context.requirements.add("saved-location-authority");
  if (method === "getSavedLocation") {
    context.requirements.add("atomic-local-turn");
  }
  return {
    op: "read",
    kind:
      method === "getSavedLocation"
        ? "saved-location-take"
        : "saved-location-peek",
    args: refs,
  };
}

function binaryExpression(context, node, refs) {
  if (
    node.operator === "instanceof" &&
    node.right.type === "Identifier" &&
    node.right.name === "Array"
  ) {
    return { op: "unary", operator: "is-array", value: refs[0] };
  }
  if (!BINARY.has(node.operator)) return null;
  jobNameComparison(context, node, refs);
  if (node.operator === "+") {
    context.concatenations.push({ left: refs[0], right: refs[1], node });
  }
  return {
    op: "binary",
    operator: node.operator,
    left: refs[0],
    right: refs[1],
  };
}

/** Rhino's loose `getJob() == "NAME"` compares the server job enum by constant
 *  name; replace the string operand with that constant's numeric job ID. */
function jobNameComparison(context, node, refs) {
  if (!["==", "!="].includes(node.operator)) return;
  const records = refs.map((ref) => context.expressions[ref]);
  const side = records.findIndex(
    (record) => record?.op === "literal" && typeof record.value === "string",
  );
  const other = records[1 - side];
  if (side < 0 || other?.op !== "read" || other.kind !== "job") return;
  const name = records[side].value;
  if (!Object.hasOwn(JOB_ENUM_IDS, name)) {
    blockScript(context, node, `Unsupported job enum name: ${name}`);
    return;
  }
  refs[side] = context.expressions.length;
  context.expressions.push({
    op: "literal",
    value: JOB_ENUM_IDS[name],
    raw: String(JOB_ENUM_IDS[name]),
    source: sourceSpan(side ? node.right : node.left),
  });
}

function valueExpression(node, refs) {
  if (
    node.type === "ArrayExpression" &&
    refs.length <= NPC_SCRIPT_LIMITS.arrayLength &&
    !node.elements.includes(null)
  ) {
    return { op: "array", values: refs };
  }
  if (node.type !== "MemberExpression" || node.optional) return null;
  if (node.computed) return { op: "index", value: refs[0], index: refs[1] };
  if (node.property.name === "length") return { op: "length", value: refs[0] };
  return null;
}

function operatorExpression(node, refs) {
  if (
    node.type === "LogicalExpression" &&
    ["&&", "||"].includes(node.operator)
  ) {
    return {
      op: "logical",
      operator: node.operator,
      left: refs[0],
      right: refs[1],
    };
  }
  if (node.type === "UnaryExpression" && UNARY.has(node.operator)) {
    return { op: "unary", operator: node.operator, value: refs[0] };
  }
  return null;
}

function helperExpression(context, node, refs) {
  if (node.type === "NpcHelperValue") {
    return { op: "helper-value", name: node.name };
  }
  if (node.type === "NpcHelperSet") {
    rememberHelperValue(context, node.name, refs[0]);
    return { op: "helper-set", name: node.name, value: refs[0], body: refs[1] };
  }
  for (let index = 0; index < node.args.length; index++) {
    rememberHelperValue(context, node.bindings[index], refs[index]);
  }
  return {
    op: "helper",
    bindings: node.bindings,
    args: refs.slice(0, -1),
    body: refs.at(-1),
  };
}

function rememberHelperValue(context, name, value) {
  if (!context.assignments.has(name)) context.assignments.set(name, []);
  context.assignments.get(name).push(value);
}

function compositeExpression(context, node, refs) {
  let result = null;
  switch (node.type) {
    case "NpcHelperExpression":
    case "NpcHelperValue":
    case "NpcHelperSet":
      return helperExpression(context, node, refs);
    case "ArrayExpression":
    case "MemberExpression":
      result = valueExpression(node, refs);
      break;
    case "BinaryExpression":
      result = binaryExpression(context, node, refs);
      break;
    case "LogicalExpression":
    case "UnaryExpression":
      result = operatorExpression(node, refs);
      break;
    case "ConditionalExpression":
      result = { op: "conditional", test: refs[0], yes: refs[1], no: refs[2] };
      break;
    case "CallExpression":
      return localRead(context, node, refs);
    default:
      break;
  }
  if (!result) {
    blockScript(context, node, `Unsupported expression: ${node.type}`);
  }
  return result;
}

function expressionRecord(context, scope, node, refs) {
  if (node.type === "Literal") return literal(context, node);
  if (node.type !== "Identifier") {
    return compositeExpression(context, node, refs);
  }
  if (node.name === "undefined") return { op: "undefined" };
  const variable = resolveVariable(
    context,
    node.npcGlobal ? "global" : scope,
    node,
  );
  if (variable?.host) {
    blockScript(
      context,
      node,
      "Host imports may only occur in the exact static ShopFactory translation",
    );
    return null;
  }
  return variable ? { op: "variable", name: variable.key } : null;
}

/** Postorder graph lowering; logical/conditional edges remain lazy at runtime. */
export function compileExpression(context, scope, root) {
  if (context.expressionRefs.has(root)) return context.expressionRefs.get(root);
  const pending = [{ node: root, leave: false }];
  let steps = 0;
  while (pending.length) {
    if (steps++ >= NPC_SCRIPT_LIMITS.nodes * 2) {
      throw new Error("NPC expression traversal limit");
    }
    const { node, leave } = pending.pop();
    if (!node) {
      blockScript(context, root, "Sparse expressions are unsupported");
      continue;
    }
    if (context.expressionRefs.has(node)) continue;
    const service = npcServiceExpression(context, scope, node);
    const children = serviceOperands(service, node);
    if (!leave) {
      pending.push({ node, leave: true });
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push({ node: children[index], leave: false });
      }
      continue;
    }
    if (context.expressions.length >= NPC_SCRIPT_LIMITS.expressions) {
      throw new Error("NPC expression limit");
    }
    const refs = children.map(
      (child) => context.expressionRefs.get(child) ?? null,
    );
    const record =
      serviceRecord(service, refs) ??
      expressionRecord(context, scope, node, refs);
    const id = context.expressions.length;
    context.expressions.push({
      ...(record ?? { op: "unsupported" }),
      source: sourceSpan(node),
    });
    context.expressionRefs.set(node, id);
  }
  return context.expressionRefs.get(root);
}

function serviceRecord(service, refs) {
  if (!service) return null;
  const record = { ...service };
  delete record.operands;
  return record.op === "read" ? { ...record, args: refs } : record;
}

function serviceOperands(service, node) {
  if (service && service.op !== "read") return [];
  return service?.operands ?? expressionChildren(node);
}

function dependencyIndex(context, expression) {
  const record = context.expressions[expression];
  return record?.op === "literal" && Number.isSafeInteger(record.value)
    ? record.value
    : "all";
}

function dependencyEdges(context, work, state, record) {
  if (record.op === "variable" || record.op === "helper-value") {
    return variableDependencyEdges(context, work, state, record);
  } else if (record.op === "helper" || record.op === "helper-set") {
    work.push({ expression: record.body, path: state.path });
  } else if (record.op === "index") {
    work.push({
      expression: record.value,
      path: [dependencyIndex(context, record.index), ...state.path],
    });
  } else if (record.op === "conditional") {
    work.push(
      { expression: record.yes, path: state.path },
      { expression: record.no, path: state.path },
    );
  } else if (record.op === "array") {
    return arrayDependencyEdges(
      work,
      state.path.length ? state.path : ["all"],
      record,
    );
  } else if (
    record.op === "literal" &&
    state.path.every((part) => part === "all")
  ) {
    // Scalar alternatives are reachable only outside authored Array branches.
    work.push({ expression: state.expression, path: [] });
  } else return false;
  return true;
}

function variableDependencyEdges(context, work, state, record) {
  const assignments = context.assignments.get(record.name) ?? [];
  if (!assignments.length || context.unboundedAssignments.has(record.name)) {
    return false;
  }
  for (const expression of assignments) {
    work.push({ expression, path: state.path });
  }
  return true;
}

function arrayDependencyEdges(work, sourcePath, record) {
  const [index, ...path] = sourcePath;
  if (index === "all") {
    for (const expression of record.values) work.push({ expression, path });
  } else if (index >= 0 && index < record.values.length) {
    work.push({ expression: record.values[index], path });
  } else return false;
  return true;
}

function dependencyLeaf(record, state, op) {
  return record?.op === op && state.path.length === 0;
}

function suffixEdges(context, work, state, record) {
  if (record.op === "binary" && record.operator === "+") {
    work.push({ expression: record.right, path: state.path });
  } else if (record.op === "variable") {
    for (const expression of context.assignments.get(record.name) ?? []) {
      work.push({ expression, path: state.path });
    }
  } else {
    dependencyEdges(context, work, state, record);
  }
}

function trailingMarkupCode(record) {
  if (record.op !== "literal" || typeof record.value !== "string") return null;
  const match = /#([ptivzmocuay@])$/.exec(record.value);
  if (!match) return null;
  let consumed = 0;
  for (const token of record.value.matchAll(NPC_MARKUP_TOKENS)) {
    consumed = token.index + token[0].length;
  }
  return match.index >= consumed ? match : null;
}

/** Resolve aliased string prefixes before collecting finite markup ID expressions. */
export function collectConcatenationDependencies(context) {
  for (const request of context.concatenations) {
    const work = [{ expression: request.left, path: [] }],
      seen = new Set();
    let index = 0;
    for (; index < work.length && index < NPC_SCRIPT_LIMITS.nodes; index++) {
      spendAnalysisStep(context, request.node);
      const state = work[index],
        key = `${state.expression}:${state.path.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const record = context.expressions[state.expression];
      if (!record) continue;
      const match = trailingMarkupCode(record);
      if (match) {
        context.dependencyRequests.push({
          kind: NPC_MARKUP_FAMILIES[match[1]],
          markupCode: match[1],
          expression: request.right,
          node: request.node,
        });
      } else suffixEdges(context, work, state, record);
      if (work.length > NPC_SCRIPT_LIMITS.nodes) break;
    }
    if (index < work.length) {
      blockScript(
        context,
        request.node,
        "Text dependency traversal limit exceeded",
      );
    }
  }
}

function recordDependency(context, request, id) {
  if (request.markupCode && Number.isSafeInteger(id)) {
    id = npcMarkupId(request.markupCode, id);
  }
  if (
    request.kind === "itemIds" &&
    (!Number.isSafeInteger(id) || id < 1000000 || id > 5999999)
  ) {
    blockScript(
      context,
      request.node,
      "Item dependency alternatives include a non-item ID; branch-correlated recipe state is unsupported",
    );
    return;
  }
  addDependency(context, request.kind, id, request.node);
  if (!request.plainGrant) return;
  const pet = Math.floor(id / 1000) === 5000;
  if (Math.floor(id / 1000000) === 1) {
    context.requirements.add(
      "equipment-grants:original-template-no-enhanced-crafting",
    );
  }
  if (pet) {
    blockScript(
      context,
      request.node,
      `gainItem(${id}) requires pet instance authority`,
    );
  }
}

/** Close over every possible literal-array selection, never over a guessed current branch. */
export function collectExpressionDependencies(context) {
  for (const request of context.dependencyRequests) {
    const work = [{ expression: request.expression, path: [] }],
      seen = new Set();
    let found = false,
      complete = true,
      index = 0;
    for (; index < work.length && index < NPC_SCRIPT_LIMITS.nodes; index++) {
      spendAnalysisStep(context, request.node);
      const state = work[index],
        key = `${state.expression}:${state.path.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const record = context.expressions[state.expression];
      if (recordDependencyLeaf(context, request, state, record)) found = true;
      else if (!record || !dependencyEdges(context, work, state, record)) {
        complete = false;
      }
      if (work.length > NPC_SCRIPT_LIMITS.nodes) break;
    }
    if (!complete || !found || index < work.length) {
      blockScript(
        context,
        request.node,
        `${request.kind} must have a complete finite literal dependency set`,
      );
    }
  }
}

/** Selection-indexed arithmetic warps close over their finite domain. */
function arithmeticMapIds(context, request, expression) {
  const domain = npcNumericDomain(context.program, expression);
  if (!domain) return false;
  for (const id of domain) recordDependency(context, request, id);
  return true;
}

function recordDependencyLeaf(context, request, state, record) {
  if (
    request.kind === "mapIds" &&
    record?.op === "read" &&
    ["saved-location-take", "saved-location-peek"].includes(record.kind) &&
    state.path.length === 0
  ) {
    return true;
  }
  if (request.kind === "mapIds" && dependencyLeaf(record, state, "binary")) {
    return arithmeticMapIds(context, request, state.expression);
  }
  if (!dependencyLeaf(record, state, "literal")) return false;
  recordDependency(context, request, record.value);
  return true;
}

/** A length-bound loop must close over literal bounded arrays, including aliases. */
export function collectLoopBounds(context) {
  for (const request of context.loopBounds) {
    collectLoopBound(context, request);
  }
}

/** Resolve one array-bound closure with an independent visited set and work budget. */
function collectLoopBound(context, request) {
  const work = [{ expression: request.expression, path: [] }],
    seen = new Set();
  let found = false,
    complete = true,
    index = 0;
  for (; index < work.length && index < NPC_SCRIPT_LIMITS.nodes; index++) {
    spendAnalysisStep(context, request.node);
    const state = work[index],
      key = `${state.expression}:${state.path.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const record = context.expressions[state.expression];
    if (dependencyLeaf(record, state, "array")) found = true;
    else if (dependencyLeaf(record, state, "literal")) continue;
    else if (!record || !dependencyEdges(context, work, state, record)) {
      complete = false;
    }
    if (work.length > NPC_SCRIPT_LIMITS.nodes) break;
  }
  if (!complete || !found || index < work.length) {
    blockScript(
      context,
      request.node,
      "Loop length must have a finite literal-array bound",
    );
  }
}
