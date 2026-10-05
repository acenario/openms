import {
  npcBooleanConfig,
  npcMissingQuestService,
  npcRemoteService,
  npcRemoteReceiver,
  npcRemoteLoop,
} from "./npc-script-services.js";
import {
  NPC_DIALOG_METHODS,
  NPC_SCRIPT_LIMITS,
  addDependency,
  blockScript,
  call,
  cmMethod,
  dependencySets,
  integerLiteral,
  parseNpcSource,
  resolveVariable,
  sourceSpan,
  playerMethod,
} from "./npc-script-ir.js";
import {
  collectConcatenationDependencies,
  collectExpressionDependencies,
  collectLoopBounds,
  compileExpression,
} from "./npc-script-expressions.js";
import {
  boundedLoop,
  loopComparison,
  inspectScopes,
  staticJavaShop,
} from "./npc-script-scope.js";
import { validateCallbackOutputs } from "./npc-script-flow.js";
import { collectArtworkDependencies } from "./npc-script-artwork.js";
import { lowerNpcHelpers } from "./npc-script-helpers.js";
import { SAVED_LOCATION_TYPES } from "../src/profile/profile-domains.js";
import { lowerNpcArrayAssignment } from "./npc-script-arrays.js";
import { lowerNpcRecords } from "./npc-script-records.js";

const EFFECTS = Object.freeze({
  gainMeso: { kind: "meso", min: 1, max: 1 },
  changeJobById: { kind: "job", min: 1, max: 1 },
  resetStats: { kind: "reset-stats", min: 0, max: 0 },
  warp: { kind: "warp", min: 1, max: 2, dependency: "mapIds" },
  gainItem: { kind: "item", min: 1, max: 3, dependency: "itemIds" },
  forceStartQuest: {
    kind: "quest-start",
    min: 1,
    max: 2,
    dependency: "questIds",
  },
  startQuest: { kind: "quest-start", min: 1, max: 2, dependency: "questIds" },
  forceCompleteQuest: {
    kind: "quest-complete",
    min: 1,
    max: 2,
    dependency: "questIds",
  },
  completeQuest: {
    kind: "quest-complete",
    min: 1,
    max: 2,
    dependency: "questIds",
  },
});

function compilerContext(text, source) {
  return {
    text,
    source,
    blockers: [],
    astNodes: 0,
    analysisSteps: 0,
    scopes: new Map([["global", new Map()]]),
    functions: new Map(),
    variables: [],
    parents: new WeakMap(),
    nodeScopes: new WeakMap(),
    expressionRefs: new WeakMap(),
    expressions: [],
    statements: [],
    assignments: new Map(),
    dependencies: dependencySets(),
    dependencyRequests: [],
    concatenations: [],
    loopBounds: [],
    requirements: new Set(),
    unboundedAssignments: new Set(),
  };
}

function rememberAssignment(context, name, value) {
  if (!context.assignments.has(name)) context.assignments.set(name, []);
  context.assignments.get(name).push(value);
}

function declarationStatement(context, scope, node) {
  const values = [];
  for (const declaration of node.declarations) {
    const variable = resolveVariable(context, scope, declaration.id);
    if (
      !variable ||
      variable.host ||
      (!declaration.init && node.kind === "var")
    ) {
      continue;
    }
    const initializer = declaration.init ?? {
      type: "Identifier",
      name: "undefined",
      start: declaration.start,
      end: declaration.end,
      loc: declaration.loc,
    };
    const value = compileExpression(context, scope, initializer);
    values.push({ name: variable.key, value });
    rememberAssignment(context, variable.key, value);
  }
  return { op: "declare", values };
}

function assignmentStatement(context, scope, node) {
  if (
    node.type === "AssignmentExpression" &&
    node.left.type === "MemberExpression"
  ) {
    node = lowerNpcArrayAssignment(context, scope, node);
  }
  const target =
    node.type === "AssignmentExpression" ? node.left : node.argument;
  const variable = resolveVariable(context, scope, target);
  if (!variable || variable.host || variable.kind === "const") {
    blockScript(
      context,
      node,
      "Only mutable local scalar/array bindings may be assigned",
    );
    return { op: "unsupported" };
  }
  if (
    node.type === "UpdateExpression" &&
    ["++", "--"].includes(node.operator)
  ) {
    context.unboundedAssignments.add(variable.key);
    return {
      op: "update",
      name: variable.key,
      delta: node.operator === "++" ? 1 : -1,
    };
  }
  if (!["=", "+=", "-=", "*=", "/=", "%="].includes(node.operator)) {
    blockScript(
      context,
      node,
      `Unsupported assignment operator: ${node.operator}`,
    );
    return { op: "unsupported" };
  }
  const value = compileExpression(context, scope, node.right);
  recordAssignmentOperation(context, { node, target, variable, value }, scope);
  return { op: "assign", name: variable.key, operator: node.operator, value };
}

function recordAssignmentOperation(context, assignment, scope) {
  const { node, target, variable, value } = assignment;
  if (node.operator === "=") {
    rememberAssignment(context, variable.key, value);
    return;
  }
  if (node.operator === "+=") {
    context.concatenations.push({
      left: compileExpression(context, scope, target),
      right: value,
      node,
    });
    rememberAssignment(context, variable.key, value);
  }
  context.unboundedAssignments.add(variable.key);
  context.requirements.add("finite-checked-scalar-arithmetic");
}

function numberOptions(context, node) {
  const bounds = node.arguments.slice(1).map(integerLiteral);
  if (
    bounds.length !== 3 ||
    bounds.some(
      (value) => value === null || value < -2147483648 || value > 2147483647,
    )
  ) {
    blockScript(
      context,
      node,
      "Number prompt requires literal signed-int default/min/max",
    );
  } else if (bounds[1] > bounds[0] || bounds[0] > bounds[2]) {
    blockScript(
      context,
      node,
      "Authored number default is outside min/max; native normalization is not represented",
    );
  }
  return {
    speaker: 0,
    defaultValue: bounds[0],
    min: bounds[1],
    max: bounds[2],
  };
}

function promptOptions(context, node, kind) {
  const args = node.arguments;
  if (kind === "number") return numberOptions(context, node);
  if (kind === "text") {
    if (args.length !== 1) {
      blockScript(context, node, "Unsupported sendGetText overload");
    }
    return {
      speaker: 0,
      defaultValue: "",
      minLength: 0,
      maxLength: NPC_SCRIPT_LIMITS.inputLength,
      lengthPolicy: "bounded-browser-input; source-packet-length-fields-zero",
    };
  }
  if (args.length < 1 || args.length > 2) {
    blockScript(context, node, "Unsupported speaker prompt overload");
  }
  const speaker = args.length === 2 ? integerLiteral(args[1]) : 0;
  if (speaker === null || speaker < 0 || speaker > 3) {
    blockScript(
      context,
      node,
      "Speaker must be a literal NPC protocol value 0..3",
    );
  }
  return { speaker };
}

function dialogStatement(context, scope, node, spec) {
  const options = promptOptions(context, node, spec.kind),
    text = node.arguments[0];
  if (!text) blockScript(context, node, "Missing authored dialog text");
  context.requirements.add(`dialog:${spec.kind}`);
  context.requirements.add("rendered-markup-dependencies-closed");
  return {
    op: "dialog",
    method: cmMethod(node),
    ...spec,
    ...options,
    text: text ? compileExpression(context, scope, text) : null,
  };
}

function itemEffect(context, node, refs) {
  const args = node.arguments,
    last = args.at(-1);
  const showOnly =
    args.length === 2 &&
    last.type === "Literal" &&
    typeof last.value === "boolean";
  if (
    args.length === 3 &&
    (last.type !== "Literal" || typeof last.value !== "boolean")
  ) {
    blockScript(
      context,
      node,
      "gainItem show-message flag must be a literal boolean",
    );
  }
  const quantity = args.length === 1 || showOnly ? 1 : integerLiteral(args[1]);
  context.dependencyRequests.push({
    kind: "itemIds",
    expression: refs[0],
    node,
    plainGrant: quantity === null || quantity >= 0,
  });
  context.requirements.add(
    "schema5-item-template-capacity-and-instance-admission",
  );
  return {
    op: "effect",
    kind: "item",
    args: refs,
    overload: showOnly ? "id-show" : "id-quantity-show",
  };
}

// GenericPortal authority publishes only one warp and its sound.
const PORTAL_EFFECT_KINDS = new Set(["warp", "portal-sound"]);

function admitPortalEffect(context, node, kind) {
  if (context.portal && !PORTAL_EFFECT_KINDS.has(kind)) {
    blockScript(context, node, `Unsupported portal effect: ${kind}`);
  }
}

function effectStatement(context, scope, node, spec) {
  const args = node.arguments;
  admitPortalEffect(context, node, spec.kind);
  if (args.length < spec.min || args.length > spec.max) {
    blockScript(context, node, "Unsupported local effect overload");
  }
  const refs = args.map((argument) =>
    compileExpression(context, scope, argument),
  );
  if (spec.kind === "job" || spec.kind === "reset-stats") {
    compileJobPolicy(context, node, spec.kind, refs);
  }
  context.requirements.add("atomic-local-turn");
  if (spec.kind === "warp") context.requirements.add("atomic-field-travel");
  if (spec.kind === "item") return itemEffect(context, node, refs);
  if (spec.dependency && refs.length) {
    context.dependencyRequests.push({
      kind: spec.dependency,
      expression: refs[0],
      node,
    });
  }
  if (spec.kind.startsWith("quest-")) {
    if (refs.length === 2) {
      context.dependencyRequests.push({
        kind: "npcIds",
        expression: refs[1],
        node,
      });
    }
    context.requirements.add(
      "quest-state-only-definition:no-timers-no-custom-progress-no-repeat-counters",
    );
  }
  return { op: "effect", kind: spec.kind, args: refs };
}

function compileJobPolicy(context, node, kind, refs) {
  if (kind === "job" && npcBooleanConfig(context, "USE_ENFORCE_JOB_SP_RANGE")) {
    throw new Error(
      "Enforced job SP accounting requires unavailable server progression authority",
    );
  }
  const name =
    kind === "job" ? "USE_STARTING_AP_4" : "USE_AUTOASSIGN_STARTERS_AP";
  const value = npcBooleanConfig(context, name);
  refs.push(context.expressions.length);
  context.expressions.push({
    op: "literal",
    value,
    raw: String(value),
    source: sourceSpan(node),
  });
}

function continuationCall(context, scope, node) {
  if (node.callee.type !== "Identifier") return null;
  const name = node.callee.name,
    definition = context.functions.get(name);
  if (
    !definition ||
    context.scopeOwners.get(scope) === "global" ||
    node.arguments.length > 3
  ) {
    return null;
  }
  return {
    op: "call",
    name,
    args: node.arguments.map((argument) =>
      compileExpression(context, scope, argument),
    ),
  };
}

function terminalCall(context, node, method) {
  if (method === "dispose" && node.arguments.length === 0) {
    return { op: "dispose" };
  }
  if (method !== "openShopNPC" || node.arguments.length !== 1) return null;
  const shopId = integerLiteral(node.arguments[0]);
  addDependency(context, "shopIds", shopId, node);
  return { op: "shop", shopId, translation: "cm.openShopNPC(literal)" };
}

/** Exact authored Java storage bridge; arguments are verified, never evaluated as host calls. */
function storageCall(context, node) {
  if (!call(node, "sendStorage") || node.arguments.length !== 2) return null;
  const storage = node.callee.object;
  if (!call(storage, "getStorage") || storage.arguments.length !== 0) {
    return null;
  }
  const player = storage.callee.object;
  const client = node.arguments[0];
  if (
    cmMethod(player) !== "getPlayer" ||
    player.arguments.length !== 0 ||
    cmMethod(client) !== "getClient" ||
    client.arguments.length !== 0
  ) {
    return null;
  }
  const npcId = integerLiteral(node.arguments[1]);
  addDependency(context, "npcIds", npcId, node);
  context.requirements.add("account-local-storage");
  return { op: "storage", npcId };
}

/** Character.setCS toggles chaos-scroll crafting, not cash-shop state. */
function craftingScrollCall(context, scope, node) {
  if (!call(node, "setCS")) return null;
  const player = node.callee.object;
  if (cmMethod(player) !== "getPlayer" || player.arguments.length !== 0) {
    return null;
  }
  if (
    node.arguments.length !== 1 ||
    (node.arguments[0].type === "Literal" &&
      typeof node.arguments[0].value !== "boolean")
  ) {
    blockScript(context, node, "setCS requires exactly one boolean argument");
  }
  return effectStatement(context, scope, node, {
    kind: "crafting-scroll",
    min: 1,
    max: 1,
  });
}

function savedLocationCall(context, scope, node) {
  if (playerMethod(node) !== "saveLocation") return null;
  const type = node.arguments[0]?.value;
  if (node.arguments.length !== 1 || !SAVED_LOCATION_TYPES.includes(type)) {
    blockScript(
      context,
      node,
      "Saved location requires one literal native location type",
    );
    return { op: "unsupported" };
  }
  context.requirements.add("saved-location-authority");
  return effectStatement(context, scope, node, {
    kind: "save-location",
    min: 1,
    max: 1,
  });
}

function defaultDialog(context, scope, node) {
  if (cmMethod(node) !== "sendDefault") return null;
  if (node.arguments.length || typeof context.defaultTalk !== "string") {
    blockScript(
      context,
      node,
      "sendDefault requires the routed NPC's original String.wz d0 text",
    );
    return { op: "unsupported" };
  }
  const text = { ...node, type: "Literal", value: context.defaultTalk };
  delete text.callee;
  delete text.arguments;
  const translated = {
    ...node,
    callee: {
      ...node.callee,
      property: { ...node.callee.property, name: "sendOk" },
    },
    arguments: [text],
  };
  return dialogStatement(context, scope, translated, NPC_DIALOG_METHODS.sendOk);
}

function callStatement(context, scope, node) {
  const remote =
    npcMissingQuestService(context, node) ??
    npcRemoteService(node, context.portal) ??
    npcRemoteReceiver(context, scope, node);
  if (remote) return { op: "unavailable", service: remote };
  const saved =
    savedLocationCall(context, scope, node) ??
    defaultDialog(context, scope, node);
  if (saved) return saved;
  const storage = storageCall(context, node);
  if (storage) return storage;
  const crafting = craftingScrollCall(context, scope, node);
  if (crafting) return crafting;
  const javaShop = staticJavaShop(context, scope, node);
  if (javaShop) {
    addDependency(context, "shopIds", javaShop.shopId, node);
    return { op: "shop", ...javaShop };
  }
  return localCallStatement(context, scope, node);
}

function localCallStatement(context, scope, node) {
  const method = cmMethod(node);
  // PortalPlayerInteraction.playPortalSound; NPCConversationManager has no such member.
  if (context.portal && method === "playPortalSound") {
    return effectStatement(context, scope, node, {
      kind: "portal-sound",
      min: 0,
      max: 0,
    });
  }
  if (Object.hasOwn(NPC_DIALOG_METHODS, method)) {
    return dialogStatement(context, scope, node, NPC_DIALOG_METHODS[method]);
  }
  if (Object.hasOwn(EFFECTS, method)) {
    return effectStatement(context, scope, node, EFFECTS[method]);
  }
  const terminal =
    terminalCall(context, node, method) ??
    continuationCall(context, scope, node);
  if (terminal) return terminal;
  blockScript(
    context,
    node,
    `Unsupported statement call: ${method ?? context.text.slice(node.callee.start, node.callee.end)}`,
  );
  return { op: "unsupported" };
}

function expressionStatement(context, scope, node) {
  const expression = node.expression;
  if (["AssignmentExpression", "UpdateExpression"].includes(expression.type)) {
    return assignmentStatement(context, scope, expression);
  }
  if (expression.type === "CallExpression") {
    return callStatement(context, scope, expression);
  }
  if (expression.type === "Literal" && typeof expression.value === "string") {
    blockScript(
      context,
      node,
      "Script directives are unsupported; semantics must not be changed by dropping them",
    );
    return { op: "unsupported" };
  }
  blockScript(
    context,
    node,
    `Unsupported expression statement: ${expression.type}`,
  );
  return { op: "unsupported" };
}

function childStatement(context, work, node) {
  if (!node) return null;
  if (context.statements.length >= NPC_SCRIPT_LIMITS.statements) {
    throw new Error("NPC statement limit");
  }
  const id = context.statements.length;
  context.statements.push(null);
  work.push({ node, id });
  return id;
}
function loopAfter(context, work, node, scope) {
  if (node.update?.type !== "SequenceExpression") return null;
  const body = node.update.expressions.slice(1).map((expression) => {
    const statement = {
      type: "ExpressionStatement",
      expression,
      start: expression.start,
      end: expression.end,
      loc: expression.loc,
    };
    context.nodeScopes.set(statement, scope);
    return statement;
  });
  const block = {
    type: "BlockStatement",
    body,
    start: node.update.start,
    end: node.update.end,
    loc: node.update.loc,
  };
  context.nodeScopes.set(block, scope);
  return childStatement(context, work, block);
}

function lexicalBindings(context, node) {
  const scope =
    node.type === "Program" ? "global" : context.blockScopes.get(node);
  return [...(context.scopes.get(scope)?.values() ?? [])]
    .filter(
      (variable) => ["let", "const"].includes(variable.kind) && !variable.host,
    )
    .map((variable) => variable.key);
}

function switchStatement(context, work, node, scope) {
  const cases = node.cases.map((branch) => {
    const block = {
      ...branch,
      type: "BlockStatement",
      body: branch.consequent,
    };
    context.nodeScopes.set(block, scope);
    return {
      test:
        branch.test === null
          ? null
          : compileExpression(context, scope, branch.test),
      body: childStatement(context, work, block),
    };
  });
  return {
    op: "switch",
    test: compileExpression(
      context,
      context.scopeParents.get(scope),
      node.discriminant,
    ),
    cases,
    lexicals: lexicalBindings(context, node),
  };
}

function controlStatement(context, work, node, scope) {
  if (node.type === "SwitchStatement") {
    return switchStatement(context, work, node, scope);
  }
  if (node.type === "BlockStatement" || node.type === "Program") {
    return {
      op: "block",
      lexicals: lexicalBindings(context, node),
      body: node.body
        .filter((child) => child.type !== "FunctionDeclaration")
        .map((child) => childStatement(context, work, child)),
    };
  }
  if (node.type === "IfStatement") {
    const test = compileExpression(context, scope, node.test);
    // An unavailable test traps on arrival, so neither branch is reachable.
    if (context.expressions[test]?.op === "unavailable") {
      return { op: "unavailable", service: context.expressions[test].service };
    }
    return {
      op: "if",
      test,
      yes: childStatement(context, work, node.consequent),
      no: childStatement(context, work, node.alternate),
    };
  }
  return node.type === "ForStatement"
    ? forStatement(context, work, node, scope)
    : null;
}

function forStatement(context, work, node, scope) {
  const remote = npcRemoteLoop(context, scope, node);
  if (remote) return remote;
  const update =
    node.update?.type === "SequenceExpression"
      ? node.update.expressions[0]
      : node.update;
  const loop = boundedLoop(context, scope, node);
  if (!loop) {
    blockScript(
      context,
      node,
      "Only canonical finite literal/array menu-building for loops are supported",
    );
  }
  const comparison = loopComparison(node);
  if (loop && comparison.right.type === "MemberExpression") {
    context.loopBounds.push({
      expression: compileExpression(context, scope, comparison.right.object),
      node,
    });
  }
  return {
    op: "for",
    lexicals: lexicalBindings(context, node),
    ...loop,
    init: childStatement(context, work, node.init),
    test: node.test ? compileExpression(context, scope, node.test) : null,
    update: update ? assignmentStatement(context, scope, update) : null,
    body: childStatement(context, work, node.body),
    after: loopAfter(context, work, node, scope),
  };
}

function leafStatement(context, scope, node) {
  if (node.type === "VariableDeclaration") {
    return declarationStatement(context, scope, node);
  }
  if (node.type === "ExpressionStatement") {
    return expressionStatement(context, scope, node);
  }
  if (node.type === "EmptyStatement") return { op: "empty" };
  if (node.type === "BreakStatement" && !node.label) {
    let parent = context.parents.get(node);
    for (let depth = 0; parent && depth < NPC_SCRIPT_LIMITS.depth; depth++) {
      if (["ForStatement", "SwitchStatement"].includes(parent.type)) {
        return { op: "break" };
      }
      if (parent.type === "FunctionDeclaration") break;
      parent = context.parents.get(parent);
    }
  }
  if (node.type === "ReturnStatement" && !node.argument) {
    return { op: "return" };
  }
  blockScript(context, node, `Unsupported statement: ${node.type}`);
  return { op: "unsupported" };
}

function compileBody(context, root) {
  const work = [],
    entry = childStatement(context, work, root);
  for (let index = 0; index < work.length; index++) {
    const { node, id } = work[index],
      scope = context.nodeScopes.get(node) ?? "global";
    const record =
      controlStatement(context, work, node, scope) ??
      leafStatement(context, scope, node);
    context.statements[id] = { ...record, source: sourceSpan(node) };
  }
  return entry;
}

function compiledProgram(context, root) {
  const initial = compileBody(context, root),
    functions = {};
  for (const [name, node] of context.functions) {
    functions[name] = {
      entry: compileBody(context, node.body),
      parameters: node.params.map(
        (parameter) =>
          context.scopes.get(name).get(parameter.name)?.key ?? null,
      ),
      locals: context.variables
        .filter((variable) => variable.owner === name && !variable.host)
        .map((variable) => variable.key),
    };
  }
  collectConcatenationDependencies(context);
  collectExpressionDependencies(context);
  collectLoopBounds(context);
  collectArtworkDependencies(context);
  return {
    schemaVersion: 2,
    initial,
    functions,
    globals: context.variables
      .filter((variable) => variable.owner === "global" && !variable.host)
      .map((variable) => variable.key),
    expressions: context.expressions,
    statements: context.statements,
    limits: NPC_SCRIPT_LIMITS,
    sourceOffsetUnit: "utf16-code-unit",
    valueSemantics:
      "bounded-primitives-and-immutable-arrays; integer-index-only; lazy-logical-and-conditional",
    turnSemantics:
      "run-callback-to-completion-then-atomically-commit-before-publishing-view",
  };
}

/** Complete-source closed-world compilation; any blocker removes the entire executable IR. */
export function compileNpcScript(input) {
  const { text, path, sha256 } = input;
  const context = compilerContext(text, { path, sha256 });
  context.defaultTalk = input.defaultTalk;
  context.staticConfig = input.staticConfig;
  context.originalQuestIds = input.originalQuestIds;
  context.eventManagers = input.eventManagers;
  context.portal = input.portal === true;
  let program = null;
  try {
    const parsed = parseNpcSource(text);
    const root = lowerNpcHelpers(
      context,
      lowerNpcRecords(
        context,
        context.portal ? input.lowerSource(parsed) : parsed,
      ),
    );
    inspectScopes(context, root);
    context.root = root;
    program = compiledProgram(context, root);
    if (!context.blockers.length) {
      validateCallbackOutputs(context, program, root);
    }
  } catch (error) {
    context.blockers.push({
      source: path,
      start: error.pos ?? 0,
      end: error.pos ?? 0,
      line: error.loc?.line ?? 1,
      column: error.loc?.column ?? 0,
      reason: `Complete-source compilation failed: ${error.message}`,
    });
  }
  return {
    schemaVersion: 1,
    source: { path, sha256 },
    status: context.blockers.length ? "blocked" : "supported",
    blockers: context.blockers,
    astNodes: context.astNodes,
    requirements: [...context.requirements].sort(),
    dependencies: Object.fromEntries(
      Object.entries(context.dependencies).map(([kind, values]) => [
        kind,
        kind === "artworkPaths"
          ? [...values].sort()
          : [...values].sort((a, b) => a - b),
      ]),
    ),
    program: context.blockers.length ? null : program,
  };
}
