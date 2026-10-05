import { npcOutputsWithinLimit } from "./npc-script-output.js";
import { validateNpcReferences } from "./npc-script-dependencies.js";
import { validNpcArtworkPath } from "./npc-script-markup.js";
import { NPC_REMOTE_SERVICES } from "./npc-script-values.js";
import {
  NPC_DIALOG_TYPES,
  NPC_READ_TYPES,
  NPC_RUNTIME_LIMITS as LIMITS,
  npcInteger,
  requireNpc,
} from "./npc-script-values.js";

export const NPC_SCRIPT_REQUIREMENTS = Object.freeze([
  "atomic-local-turn",
  "atomic-field-travel",
  "account-local-storage",
  "finite-checked-scalar-arithmetic",
  "saved-location-authority",
  "schema5-item-template-capacity-and-instance-admission",
  "quest-state-only-definition:no-timers-no-custom-progress-no-repeat-counters",
  "rendered-markup-dependencies-closed",
  "equipment-grants:original-template-no-enhanced-crafting",
  "dialog:say",
  "dialog:yes-no",
  "dialog:accept-decline",
  "dialog:choice",
  "dialog:number",
  "dialog:text",
]);
export const NPC_DEPENDENCY_FAMILIES = Object.freeze([
  "itemIds",
  "questIds",
  "shopIds",
  "npcIds",
  "mapIds",
  "mobIds",
  "artworkPaths",
]);
const BINARY = [
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
];
const EXPRESSIONS = Object.freeze({
  literal: "value raw",
  unavailable: "service",
  undefined: "",
  variable: "name",
  array: "values",
  helper: "bindings args body",
  "helper-value": "name",
  "helper-set": "name value body",
  index: "value index",
  length: "value",
  unary: "operator value",
  binary: "operator left right",
  logical: "operator left right",
  conditional: "test yes no",
  read: "kind args",
});
const STATEMENTS = Object.freeze({
  block: "body lexicals",
  if: "test yes no",
  switch: "test cases lexicals",
  declare: "values",
  assign: "name operator value",
  update: "name delta",
  for: "from variable maxIterations init test update body after lexicals",
  call: "name args",
  dialog:
    "method kind rawType internalType speaker text prev next defaultValue min max minLength maxLength lengthPolicy",
  effect: "kind args overload",
  shop: "shopId translation",
  storage: "npcId",
  dispose: "",
  unavailable: "service",
  return: "",
  break: "",
  empty: "",
});

function shape(value, fields, required = fields) {
  requireNpc(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected an NPC record",
  );
  const keys = Object.keys(value),
    allowed = fields ? fields.split(" ") : [];
  requireNpc(
    keys.every((key) => allowed.includes(key)),
    "Unknown NPC artifact field",
  );
  for (const key of required ? required.split(" ") : []) {
    requireNpc(Object.hasOwn(value, key), `Missing NPC field ${key}`);
  }
}

function list(value, limit) {
  requireNpc(
    Array.isArray(value) && value.length <= limit,
    "NPC list exceeds its bound",
  );
  return value;
}

/** Check plain data, cycles, depth and aggregate size before structured cloning. */
function boundedCopy(value) {
  const queue = [{ value, depth: 0 }],
    seen = new Set();
  let characters = 0;
  for (let index = 0; index < queue.length; index++) {
    requireNpc(
      queue.length <= LIMITS.analysisSteps,
      "NPC artifact node budget exceeded",
    );
    const entry = queue[index],
      node = entry.value;
    requireNpc(entry.depth <= LIMITS.depth, "NPC artifact depth exceeded");
    if (typeof node === "string") characters += node.length;
    requireNpc(
      characters <= LIMITS.sourceBytes * 16,
      "NPC artifact string budget exceeded",
    );
    if (node === null || typeof node !== "object") {
      requireNpc(
        node === null || ["string", "number", "boolean"].includes(typeof node),
        "NPC artifact is not JSON data",
      );
      if (typeof node === "number") {
        requireNpc(Number.isFinite(node), "Nonfinite NPC artifact number");
      }
      continue;
    }
    requireNpc(!seen.has(node), "Cyclic or aliased NPC artifact");
    seen.add(node);
    requireNpc(
      Array.isArray(node) ||
        Object.getPrototypeOf(node) === Object.prototype ||
        Object.getPrototypeOf(node) === null,
      "NPC artifact has a host prototype",
    );
    const keys = Object.keys(node);
    requireNpc(
      keys.length <= LIMITS.analysisSteps,
      "NPC object budget exceeded",
    );
    if (Array.isArray(node)) {
      requireNpc(keys.length === node.length, "Sparse NPC artifact array");
    }
    for (const key of keys) {
      requireNpc(
        !["__proto__", "constructor", "prototype"].includes(key),
        "Forbidden NPC artifact key",
      );
      const field = Object.getOwnPropertyDescriptor(node, key);
      requireNpc(
        Object.hasOwn(field, "value"),
        "NPC artifact accessor is forbidden",
      );
      queue.push({ value: field.value, depth: entry.depth + 1 });
    }
  }
  return structuredClone(value);
}

function sourceSpan(source) {
  shape(source, "start end line column");
  npcInteger(source.start, 0, LIMITS.sourceBytes);
  npcInteger(source.end, source.start, LIMITS.sourceBytes);
  npcInteger(source.line, 1, LIMITS.sourceBytes);
  npcInteger(source.column, 0, LIMITS.sourceBytes);
}

function ref(id, maximum) {
  npcInteger(id, 0, maximum - 1);
}

function expressionEdges(node) {
  switch (node.op) {
    case "helper":
      return [...node.args, node.body];
    case "helper-set":
      return [node.value, node.body];
    case "array":
      return node.values;
    case "read":
      return node.args;
    case "unary":
    case "length":
      return [node.value];
    case "index":
      return [node.value, node.index];
    case "binary":
    case "logical":
      return [node.left, node.right];
    case "conditional":
      return [node.test, node.yes, node.no];
    default:
      return [];
  }
}

function validateLiteral(node) {
  requireNpc(
    node.value === null ||
      typeof node.value === "boolean" ||
      Number.isSafeInteger(node.value) ||
      (typeof node.value === "string" &&
        node.value.length <= LIMITS.textLength),
    "Invalid NPC literal",
  );
  requireNpc(
    typeof node.raw === "string" && node.raw.length <= LIMITS.sourceBytes,
    "Missing NPC literal spelling",
  );
}

function validateExpression(node, id, bindings) {
  requireNpc(
    Object.hasOwn(EXPRESSIONS, node?.op),
    "Unknown NPC expression operation",
  );
  const fields = `op source${EXPRESSIONS[node.op] ? ` ${EXPRESSIONS[node.op]}` : ""}`;
  shape(node, fields);
  sourceSpan(node.source);
  for (const edge of expressionEdges(node)) ref(edge, id);
  switch (node.op) {
    case "unavailable":
      requireNpc(
        NPC_REMOTE_SERVICES.includes(node.service),
        "Unknown remote NPC service",
      );
      break;
    case "literal":
      validateLiteral(node);
      break;
    case "variable":
      requireNpc(bindings.has(node.name), "Unknown NPC variable");
      break;
    case "helper":
      list(node.args, LIMITS.variables);
      list(node.bindings, LIMITS.variables);
      requireNpc(
        node.args.length <= node.bindings.length,
        "Invalid NPC helper arguments",
      );
      break;
    case "helper-value":
    case "helper-set":
      requireNpc(
        typeof node.name === "string" &&
          /^helper#\d+:[A-Za-z_$][\w$]*$/.test(node.name),
        "Invalid NPC helper binding",
      );
      break;
    case "array":
      list(node.values, LIMITS.arrayLength);
      break;
    default:
      validateExpressionValue(node);
  }
}

function validateExpressionValue(node) {
  switch (node.op) {
    case "unary":
      requireNpc(
        ["!", "+", "-", "typeof", "is-array"].includes(node.operator),
        "Unknown NPC unary operator",
      );
      break;
    case "binary":
      requireNpc(BINARY.includes(node.operator), "Unknown NPC binary operator");
      break;
    case "logical":
      requireNpc(
        ["&&", "||"].includes(node.operator),
        "Unknown NPC logical operator",
      );
      break;
    case "read": {
      const spec = Object.hasOwn(NPC_READ_TYPES, node.kind)
        ? NPC_READ_TYPES[node.kind]
        : null;
      requireNpc(spec, "Unknown NPC local read");
      list(node.args, spec[1]);
      requireNpc(node.args.length >= spec[0], "Missing NPC read argument");
      break;
    }
  }
}

function bindingList(values, scope, all) {
  const seen = new Set();
  for (const name of list(values, LIMITS.variables)) {
    requireNpc(
      typeof name === "string" &&
        name.startsWith(`${scope}:`) &&
        /^[A-Za-z_$][\w$]*$/.test(name.slice(scope.length + 1)) &&
        !seen.has(name),
      "Invalid scoped NPC binding",
    );
    seen.add(name);
    all.add(name);
  }
  return seen;
}

function functions(program) {
  requireNpc(
    program.functions && Object.hasOwn(program.functions, "start"),
    "Missing NPC start callback",
  );
  list(Object.keys(program.functions), LIMITS.variables);
  const all = new Set(),
    scopes = { global: bindingList(program.globals, "global", all) };
  for (const name of Object.keys(program.functions)) {
    requireNpc(
      /^[A-Za-z_$][\w$]*$/.test(name) &&
        !["global", "__proto__", "constructor", "prototype"].includes(name),
      "Invalid NPC function name",
    );
    const entry = program.functions[name];
    shape(entry, "entry parameters locals");
    ref(entry.entry, program.statements.length);
    scopes[name] = bindingList(entry.locals, name, all);
    const parameters = bindingList(entry.parameters, name, all);
    requireNpc(
      parameters.size <= (name === "start" ? 0 : 3),
      "Invalid NPC callback parameters",
    );
    for (const parameter of parameters) {
      requireNpc(
        scopes[name].has(parameter),
        "NPC parameter missing from locals",
      );
    }
  }
  requireNpc(all.size <= LIMITS.variables, "NPC variable budget exceeded");
  return { all, scopes };
}

function requirement(context, name) {
  requireNpc(context.requirements.has(name), `Missing NPC requirement ${name}`);
}

function validateDialog(node, context) {
  const spec = Object.hasOwn(NPC_DIALOG_TYPES, node.method)
    ? NPC_DIALOG_TYPES[node.method]
    : null;
  requireNpc(spec, "Unknown NPC dialog method");
  for (const key of Object.keys(spec)) {
    requireNpc(
      node[key] === spec[key],
      "Inconsistent NPC raw/internal dialog type",
    );
  }
  npcInteger(node.speaker, 0, 3);
  requirement(context, `dialog:${node.kind}`);
  requirement(context, "rendered-markup-dependencies-closed");
  if (node.kind === "number") {
    npcInteger(node.min);
    npcInteger(node.max, node.min);
    npcInteger(node.defaultValue, node.min, node.max);
  } else if (node.kind === "text") {
    requireNpc(
      node.defaultValue === "" &&
        node.minLength === 0 &&
        node.maxLength === LIMITS.inputLength &&
        node.lengthPolicy ===
          "bounded-browser-input; source-packet-length-fields-zero",
      "Unsupported NPC input policy",
    );
  }
  const options =
    node.kind === "say"
      ? "prev next"
      : node.kind === "number"
        ? "defaultValue min max"
        : node.kind === "text"
          ? "defaultValue minLength maxLength lengthPolicy"
          : "";
  shape(
    node,
    `op source method kind rawType internalType speaker text${options ? ` ${options}` : ""}`,
  );
}

function effectArity(kind) {
  if (kind === "portal-sound") return [0, 0];
  if (
    ["meso", "crafting-scroll", "save-location", "remove-all"].includes(kind)
  ) {
    return [1, 1];
  }
  return [1, kind === "item" ? 3 : 2];
}

function validateEffect(node, context) {
  const [minimum, maximum] = effectArity(node.kind);
  requireNpc(
    [
      "portal-sound",
      "meso",
      "crafting-scroll",
      "save-location",
      "job",
      "reset-stats",
      "item",
      "remove-all",
      "warp",
      "quest-start",
      "quest-complete",
    ].includes(node.kind),
    "Unknown NPC effect",
  );
  list(node.args, maximum);
  requireNpc(node.args.length >= minimum, "Missing NPC effect argument");
  validateJobEffectPolicy(node, context);
  requirement(context, "atomic-local-turn");
  if (node.kind === "warp") requirement(context, "atomic-field-travel");
  if (node.kind === "save-location") {
    requirement(context, "saved-location-authority");
  }
  if (node.kind === "item") {
    requireNpc(
      ["id-show", "id-quantity-show"].includes(node.overload),
      "Unknown NPC item overload",
    );
    if (node.overload === "id-show") {
      requireNpc(node.args.length === 2, "Invalid NPC item show overload");
    }
    requirement(
      context,
      "schema5-item-template-capacity-and-instance-admission",
    );
  } else {
    requireNpc(
      !Object.hasOwn(node, "overload"),
      "Unexpected NPC effect overload",
    );
  }
  if (node.kind.startsWith("quest-")) {
    requirement(
      context,
      "quest-state-only-definition:no-timers-no-custom-progress-no-repeat-counters",
    );
    context.forceQuests = true;
  }
  context.hasEffects = true;
}

function validateJobEffectPolicy(node, context) {
  if (!["job", "reset-stats"].includes(node.kind)) return;
  requireNpc(
    node.args.length === (node.kind === "job" ? 2 : 1),
    "Invalid NPC job policy arguments",
  );
  const flag = context.program.expressions[node.args.at(-1)];
  requireNpc(
    flag.op === "literal" && typeof flag.value === "boolean",
    "NPC job policy must retain authored configuration",
  );
}

function statementEdges(node) {
  if (node.op === "block") return node.body;
  if (node.op === "switch") return node.cases.map((branch) => branch.body);
  if (node.op === "if") {
    return node.no === null ? [node.yes] : [node.yes, node.no];
  }
  if (node.op === "for") {
    return node.after === null
      ? [node.init, node.body]
      : [node.init, node.body, node.after];
  }
  return [];
}

function statementExpressions(node) {
  switch (node.op) {
    case "switch":
      return [
        node.test,
        ...node.cases
          .filter((branch) => branch.test !== null)
          .map((branch) => branch.test),
      ];
    case "if":
    case "for":
      return [node.test];
    case "declare":
      return node.values.map((entry) => entry.value);
    case "assign":
      return [node.value];
    case "call":
    case "effect":
      return node.args;
    case "dialog":
      return [node.text];
    default:
      return [];
  }
}

function validateLoop(node, program) {
  npcInteger(node.from, 0, LIMITS.loopIterations);
  requireNpc(
    node.maxIterations === LIMITS.loopIterations,
    "Invalid NPC loop budget",
  );
  shape(node.update, "op name delta");
  requireNpc(
    node.update.op === "update" &&
      node.update.name === node.variable &&
      node.update.delta === 1,
    "NPC loop must advance its declared counter",
  );
  validateLoopInitializer(node, program);
  if (node.after !== null) validateLoopAfter(node, program);
  validateLoopTest(node, program);
}
function validateLoopAfter(node, program) {
  const after = program.statements[node.after];
  requireNpc(
    after?.op === "block" && after.body.length <= 3,
    "NPC loop auxiliary updates are not bounded",
  );
  for (const id of after.body) {
    const update = program.statements[id];
    requireNpc(
      update?.op === "assign" && update.name !== node.variable,
      "NPC loop auxiliary update changes its counter",
    );
  }
}

function validateLoopInitializer(node, program) {
  const init = program.statements[node.init];
  requireNpc(
    init?.op === "declare" &&
      init.values?.length >= 1 &&
      init.values.length <= 4 &&
      init.values[0].name === node.variable,
    "NPC loop has an inconsistent initializer",
  );
  requireNpc(
    init.values.slice(1).every((entry) => entry.name !== node.variable),
    "NPC loop initializer rewrites its counter",
  );
  const from = program.expressions[init.values[0].value];
  requireNpc(
    from?.op === "literal" && from.value === node.from,
    "NPC loop initializer was altered",
  );
}

function validateLoopTest(node, program) {
  const outer = program.expressions[node.test];
  const test =
    outer?.op === "logical" && outer.operator === "&&"
      ? program.expressions[outer.right]
      : outer;
  requireNpc(
    test?.op === "binary" &&
      test.operator === "<" &&
      program.expressions[test.left]?.op === "variable" &&
      program.expressions[test.left].name === node.variable,
    "NPC loop has an inconsistent test",
  );
  validateLoopBound(program.expressions[test.right], node.from);
}

/** Canonical bounds are authored array lengths or bounded integer endpoints. */
function validateLoopBound(bound, from) {
  requireNpc(
    bound?.op === "length" ||
      (bound?.op === "literal" &&
        Number.isInteger(bound.value) &&
        bound.value >= from &&
        bound.value <= LIMITS.loopIterations),
    "NPC loop bound is not canonical",
  );
}

function validateStatement(node, id, context) {
  requireNpc(
    Object.hasOwn(STATEMENTS, node?.op),
    "Unknown NPC statement operation",
  );
  const fields = `op source${STATEMENTS[node.op] ? ` ${STATEMENTS[node.op]}` : ""}`;
  shape(
    node,
    fields,
    node.op === "dialog" || node.op === "effect" ? "op source" : fields,
  );
  sourceSpan(node.source);
  for (const edge of statementEdges(node)) {
    ref(edge, context.program.statements.length);
    requireNpc(edge > id, "Cyclic/backward NPC statement reference");
  }
  for (const edge of statementExpressions(node)) {
    ref(edge, context.program.expressions.length);
  }
  validateStatementOperation(node, context);
}

function validateStatementOperation(node, context) {
  switch (node.op) {
    case "unavailable":
      requireNpc(
        NPC_REMOTE_SERVICES.includes(node.service),
        "Unknown remote NPC service",
      );
      break;
    case "block":
      list(node.body, LIMITS.statements);
      break;
    case "switch":
      validateSwitch(node);
      break;
    case "declare":
      validateDeclarations(node.values);
      break;
    case "assign":
      validateAssignment(node, context);
      break;
    case "update":
      requireNpc(
        node.delta === 1 || node.delta === -1,
        "Invalid NPC increment",
      );
      break;
    case "for":
      validateLoop(node, context.program);
      break;
    case "call":
      validateFunctionCall(node, context.program);
      break;
    default:
      validateServiceStatement(node, context);
  }
}

function validateServiceStatement(node, context) {
  switch (node.op) {
    case "dialog":
      validateDialog(node, context);
      break;
    case "effect":
      validateEffect(node, context);
      break;
    case "shop":
      validateShop(node, context);
      break;
    case "storage":
      npcInteger(node.npcId, 1);
      requirement(context, "account-local-storage");
      requireNpc(
        context.dependencies.npcIds.has(node.npcId),
        "NPC storage is outside dependency closure",
      );
      break;
  }
}

function validateFunctionCall(node, program) {
  requireNpc(
    Object.hasOwn(program.functions, node.name),
    "Unknown NPC function",
  );
  list(node.args, 3);
}

function validateSwitch(node) {
  let defaults = 0;
  for (const branch of list(node.cases, LIMITS.statements)) {
    shape(branch, "test body");
    if (branch.test === null) defaults++;
  }
  requireNpc(defaults <= 1, "Duplicate NPC switch default");
}

function validateDeclarations(values) {
  for (const entry of list(values, LIMITS.variables)) {
    shape(entry, "name value");
  }
}

function validateAssignment(node, context) {
  requireNpc(
    ["=", "+=", "-=", "*=", "/=", "%="].includes(node.operator),
    "Unknown NPC assignment",
  );
  if (node.operator !== "=") {
    requirement(context, "finite-checked-scalar-arithmetic");
  }
}

function validateShop(node, context) {
  npcInteger(node.shopId, 1);
  requireNpc(
    context.dependencies.shopIds.has(node.shopId),
    "NPC shop is outside dependency closure",
  );
  requireNpc(
    [
      "cm.openShopNPC(literal)",
      "server.ShopFactory.getInstance().getShop(literal).sendShop(cm.getClient())",
    ].includes(node.translation),
    "Unknown NPC shop translation",
  );
}

function expressionScopes(program, scope, allowed) {
  const valid = new Uint8Array(program.expressions.length),
    global = new Uint8Array(program.expressions.length);
  for (let id = 0; id < program.expressions.length; id++) {
    const node = program.expressions[id];
    global[id] =
      node.op !== "variable" || allowed.global.has(node.name) ? 1 : 0;
    valid[id] =
      node.op !== "variable" ||
      allowed.global.has(node.name) ||
      allowed[scope].has(node.name)
        ? 1
        : 0;
    for (const edge of expressionEdges(node)) {
      if (!valid[edge]) valid[id] = 0;
      if (!global[edge]) global[id] = 0;
    }
    if (node.op === "helper" && !global[node.body]) valid[id] = 0;
  }
  return valid;
}

function scopeStatements(context, scopes) {
  const program = context.program,
    owners = new Uint8Array(program.statements.length);
  const roots = [{ entry: program.initial, scope: "global" }];
  for (const scope of Object.keys(program.functions)) {
    roots.push({ entry: program.functions[scope].entry, scope });
  }
  for (const root of roots) {
    scopeRoot(
      { program, owners, scopes, closedExpressions: context.closedExpressions },
      root,
    );
  }
  requireNpc(
    owners.every((owner) => owner === 1),
    "Unowned NPC statement",
  );
}

function validateScopedWrites(node, work, scope, scopes) {
  const writes =
    node.op === "declare"
      ? node.values.map((entry) => entry.name)
      : ["assign", "update"].includes(node.op)
        ? [node.name]
        : ["block", "switch", "for"].includes(node.op)
          ? list(node.lexicals, LIMITS.variables)
          : [];
  for (const name of writes) {
    requireNpc(
      (scopes.global.has(name) || scopes[scope].has(name)) &&
        name !== work.loop,
      "Invalid scoped NPC write or loop counter mutation",
    );
  }
  if (node.op === "call") {
    requireNpc(scope !== "global", "NPC call outside callback");
  }
  if (node.op === "return") {
    requireNpc(scope !== "global", "NPC return outside a callback");
  }
  if (node.op === "break") {
    requireNpc(work.breakable, "NPC break outside a bounded loop/switch");
  }
  if (node.op === "for") {
    requireNpc(work.loop === null, "Nested NPC loops are not admitted");
  }
}

function scopeRoot({ program, owners, scopes, closedExpressions }, root) {
  const expressions = expressionScopes(program, root.scope, scopes);
  const queue = [{ id: root.entry, loop: null, breakable: false, depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    requireNpc(
      queue.length <= LIMITS.statements,
      "NPC statement traversal limit",
    );
    const work = queue[index],
      node = program.statements[work.id];
    requireNpc(
      !owners[work.id] && work.depth <= LIMITS.depth,
      "Shared or too-deep NPC statement",
    );
    owners[work.id] = 1;
    for (const id of statementExpressions(node)) {
      requireNpc(
        expressions[id] && closedExpressions[id],
        "Cross-scope NPC expression",
      );
    }
    validateScopedWrites(node, work, root.scope, scopes);
    for (const id of statementEdges(node)) {
      queue.push({
        id,
        depth: work.depth + 1,
        breakable: work.breakable || node.op === "for" || node.op === "switch",
        loop:
          node.op === "for" && (id === node.body || id === node.after)
            ? node.variable
            : work.loop,
      });
    }
  }
}

function validateOutputs(program) {
  requireNpc(
    npcOutputsWithinLimit(program),
    "NPC callback can emit multiple views",
  );
}

function envelope(input) {
  requireNpc(
    input?.status === "supported" && input.program && input.source,
    "NPC source route is not completely supported",
    "npc-unsupported",
  );
  requireNpc(
    Array.isArray(input.blockers) && input.blockers.length === 0,
    "NPC route retains source blockers",
  );
  // Routing/SQL metadata is owned by the router; copy only this execution envelope.
  return boundedCopy({
    source: input.source,
    program: input.program,
    requirements: input.requirements,
    dependencies: input.dependencies,
  });
}

function admitDependencies(value) {
  shape(value, NPC_DEPENDENCY_FAMILIES.join(" "));
  const result = {};
  for (const family of NPC_DEPENDENCY_FAMILIES) {
    const ids = list(value[family], LIMITS.dependencies),
      seen = new Set();
    for (const id of ids) {
      if (family === "artworkPaths") {
        requireNpc(validNpcArtworkPath(id), "Invalid NPC artwork dependency");
      } else npcInteger(id, 1);
      requireNpc(!seen.has(id), "Duplicate NPC dependency");
      seen.add(id);
    }
    result[family] = seen;
  }
  return result;
}

function freezeArtifact(value) {
  const queue = [value];
  for (let index = 0; index < queue.length; index++) {
    requireNpc(
      queue.length <= LIMITS.analysisSteps,
      "NPC freeze budget exceeded",
    );
    const node = queue[index];
    if (!node || typeof node !== "object") continue;
    Object.freeze(node);
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
}

/** A helper body owns its bindings; argument edges remain in the caller's frame. */
function helperScope(node, free, analysis) {
  const required = new Set();
  if (node.op === "helper") {
    const names = new Set();
    for (const name of node.bindings) {
      requireNpc(
        ++analysis.steps <= LIMITS.analysisSteps,
        "NPC helper scope budget exceeded",
      );
      requireNpc(
        typeof name === "string" &&
          /^helper#\d+:[A-Za-z_$][\w$]*$/.test(name) &&
          !analysis.bindings.has(name),
        "Duplicate or invalid NPC helper binding",
      );
      names.add(name);
      analysis.bindings.add(name);
    }
    for (const name of free[node.body]) {
      requireNpc(
        ++analysis.steps <= LIMITS.analysisSteps,
        "NPC helper scope budget exceeded",
      );
      requireNpc(names.has(name), "Cross-frame NPC helper body");
    }
  } else if (node.op === "helper-value" || node.op === "helper-set") {
    required.add(node.name);
  }
  for (const edge of node.op === "helper" ? node.args : expressionEdges(node)) {
    for (const name of free[edge]) {
      requireNpc(
        ++analysis.steps <= LIMITS.analysisSteps,
        "NPC helper scope budget exceeded",
      );
      required.add(name);
    }
  }
  requireNpc(
    required.size <= LIMITS.variables,
    "NPC helper scope limit exceeded",
  );
  return required;
}

function validateExpressions(program, bindings) {
  const depths = new Uint16Array(program.expressions.length),
    closed = new Uint8Array(program.expressions.length),
    free = new Array(program.expressions.length),
    helperAnalysis = { bindings: new Set(), steps: 0 };
  let edges = 0;
  for (let id = 0; id < program.expressions.length; id++) {
    const node = program.expressions[id];
    validateExpression(node, id, bindings);
    free[id] = helperScope(node, free, helperAnalysis);
    closed[id] = free[id].size === 0 ? 1 : 0;
    depths[id] = 1;
    for (const edge of expressionEdges(node)) {
      requireNpc(
        ++edges <= LIMITS.analysisSteps,
        "NPC expression edge budget exceeded",
      );
      depths[id] = Math.max(depths[id], depths[edge] + 1);
    }
    requireNpc(
      depths[id] <= LIMITS.depth,
      "NPC expression depth exceeds admission",
    );
  }
  return closed;
}

function validateProvenanceAndSemantics(artifact) {
  const program = artifact.program;
  shape(artifact.source, "path sha256");
  requireNpc(
    typeof artifact.source.path === "string" &&
      artifact.source.path.length > 0 &&
      artifact.source.path.length <= 4096 &&
      /^[a-f0-9]{64}$/.test(artifact.source.sha256),
    "Invalid NPC source provenance",
  );
  shape(
    program,
    "schemaVersion initial functions globals expressions statements limits sourceOffsetUnit valueSemantics turnSemantics",
  );
  requireNpc(
    program.schemaVersion === 2 &&
      program.sourceOffsetUnit === "utf16-code-unit" &&
      program.valueSemantics ===
        "bounded-primitives-and-immutable-arrays; integer-index-only; lazy-logical-and-conditional" &&
      program.turnSemantics ===
        "run-callback-to-completion-then-atomically-commit-before-publishing-view",
    "Unknown NPC IR semantics",
  );
  shape(program.limits, Object.keys(LIMITS).join(" "));
  for (const key of Object.keys(LIMITS)) {
    requireNpc(
      program.limits[key] === LIMITS[key],
      "Altered NPC execution limits",
    );
  }
  list(program.expressions, LIMITS.expressions);
  list(program.statements, LIMITS.statements);
  ref(program.initial, program.statements.length);
}

/** Structural/source-contract admission, not a signature: router authenticates packaged bytes. */
export function admitNpcScript(input) {
  const artifact = envelope(input),
    program = artifact.program;
  validateProvenanceAndSemantics(artifact);
  const requirements = new Set(
    list(artifact.requirements, NPC_SCRIPT_REQUIREMENTS.length),
  );
  requireNpc(
    requirements.size === artifact.requirements.length,
    "Duplicate NPC requirement",
  );
  for (const name of requirements) {
    requireNpc(
      NPC_SCRIPT_REQUIREMENTS.includes(name),
      `Unsupported NPC requirement ${name}`,
    );
  }
  const context = {
    program,
    requirements,
    dependencies: admitDependencies(artifact.dependencies),
    source: artifact.source,
    hasEffects: false,
    forceQuests: false,
  };
  const bindings = functions(program);
  context.closedExpressions = validateExpressions(program, bindings.all);
  for (let id = 0; id < program.statements.length; id++) {
    validateStatement(program.statements[id], id, context);
  }
  scopeStatements(context, bindings.scopes);
  validateOutputs(program);
  validateNpcReferences(context);
  freezeArtifact(artifact);
  return context;
}
