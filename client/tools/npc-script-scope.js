import {
  admittedEventManager,
  npcRemoteService,
} from "./npc-script-services.js";
import {
  NPC_SCRIPT_LIMITS,
  astInventory,
  blockScript,
  call,
  cmMethod,
  integerLiteral,
  resolveVariable,
} from "./npc-script-ir.js";

const RESERVED = new Set([
  "cm",
  "Java",
  "Array",
  "global",
  "__proto__",
  "constructor",
  "prototype",
  "undefined",
  "start",
  "action",
]);

function shopFactoryImport(node) {
  return (
    call(node, "type") &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Java" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Literal" &&
    node.arguments[0].value === "server.ShopFactory"
  );
}

function javaImport(node) {
  if (
    !call(node, "type") ||
    node.callee.object.name !== "Java" ||
    node.arguments.length !== 1 ||
    typeof node.arguments[0].value !== "string"
  ) {
    return null;
  }
  return node.arguments[0].value;
}

function declare(context, scope, declaration, kind) {
  const node = declaration.id;
  if (node.type !== "Identifier" || RESERVED.has(node.name)) {
    blockScript(
      context,
      node,
      "Destructured/reserved declarations are unsupported",
    );
    return;
  }
  const table = context.scopes.get(scope),
    existing = table.get(node.name);
  if (
    existing &&
    (kind !== "var" ||
      !["var", "parameter"].includes(existing.kind) ||
      existing.host)
  ) {
    blockScript(
      context,
      node,
      "Redeclared lexical or host binding is unsupported",
    );
    return;
  }
  if (existing) return;
  if (context.variables.length >= NPC_SCRIPT_LIMITS.variables) {
    throw new Error("NPC variable limit");
  }
  const variable = {
    key: `${context.scopeOwners.get(scope)}:binding$${context.variables.length}`,
    name: node.name,
    scope,
    owner: context.scopeOwners.get(scope),
    kind,
    host: shopFactoryImport(declaration.init)
      ? "shop-factory"
      : javaImport(declaration.init),
    eventManager: admittedEventManager(context, declaration.init),
    remoteService: admittedEventManager(context, declaration.init)
      ? null
      : npcRemoteService(declaration.init, context.portal),
    declarationEnd: declaration.end ?? node.end,
  };
  table.set(node.name, variable);
  context.variables.push(variable);
}

function functionScope(context, node, parent) {
  const name = node.id?.name;
  if (unsupportedFunctionKind(node, parent, name)) {
    blockScript(
      context,
      node,
      "Only top-level synchronous named functions are supported",
    );
    return null;
  }
  if (context.functions.has(name)) {
    blockScript(context, node, `Duplicate entrypoint: ${name}`);
    return null;
  }
  if (
    (name === "start" && node.params.length !== 0) ||
    node.params.length > 3
  ) {
    blockScript(context, node, "Unsupported NPC entrypoint parameters");
  }
  context.functions.set(name, node);
  context.scopes.set(name, new Map());
  context.scopeOwners.set(name, name);
  context.scopeParents.set(name, "global");
  for (const parameter of node.params) {
    declare(context, name, { id: parameter }, "parameter");
  }
  return name;
}

function unsupportedFunctionKind(node, parent, name) {
  return (
    parent?.type !== "Program" ||
    node.async ||
    node.generator ||
    (RESERVED.has(name) && !["start", "action"].includes(name))
  );
}

/** Hoisted var bindings coexist with unique lexical block bindings and runtime TDZ checks. */
export function inspectScopes(context, root) {
  const nodes = astInventory(root),
    ownership = new WeakMap([[root, "global"]]);
  context.scopeOwners = new Map([["global", "global"]]);
  context.scopeParents = new Map();
  context.blockScopes = new WeakMap();
  for (const node of nodes) {
    const parent = context.parents.get(node),
      inherited = ownership.get(node) ?? "global";
    let scope = inherited;
    if (node.type === "FunctionDeclaration") {
      scope = functionScope(context, node, parent) ?? inherited;
    }
    if (
      ["BlockStatement", "SwitchStatement", "ForStatement"].includes(node.type)
    ) {
      const child = `${scope}$block${context.scopes.size}`;
      context.scopes.set(child, new Map());
      context.scopeOwners.set(child, context.scopeOwners.get(scope));
      context.scopeParents.set(child, scope);
      context.blockScopes.set(node, child);
      scope = child;
    }
    context.nodeScopes.set(node, scope);
    inheritChildScopes(context, node, scope, ownership);
    if (node.type === "VariableDeclaration") {
      inspectDeclarations(context, node, parent, scope);
    }
  }
  declareSloppyGlobals(context, root);
  for (const variable of context.variables) {
    if (context.functions.has(variable.name)) {
      blockScript(
        context,
        root,
        "Authored function bindings cannot be shadowed or reassigned",
      );
    }
  }
  if (!context.functions.has("start")) {
    blockScript(context, root, "Missing start entrypoint");
  }
  context.astNodes = nodes.length;
}

function declareSloppyGlobals(context, root) {
  for (const expression of astInventory(root)) {
    if (
      expression.type !== "AssignmentExpression" ||
      expression.operator !== "=" ||
      expression.left.type !== "Identifier"
    ) {
      continue;
    }
    let scope = context.nodeScopes.get(expression),
      found = false;
    for (let depth = 0; scope && depth <= NPC_SCRIPT_LIMITS.depth; depth++) {
      if (context.scopes.get(scope)?.has(expression.left.name)) {
        found = true;
        break;
      }
      scope = context.scopeParents.get(scope);
    }
    if (!found) declare(context, "global", { id: expression.left }, "var");
  }
}

function inheritChildScopes(context, node, scope, ownership) {
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!child || typeof child.type !== "string") continue;
      context.parents.set(child, node);
      ownership.set(child, scope);
    }
  }
}

function inspectDeclarations(context, node, parent, scope) {
  for (const declaration of node.declarations) {
    const host = javaImport(declaration.init);
    if (
      host &&
      ![
        "server.ShopFactory",
        "config.YamlConfig",
        "constants.game.GameConstants",
        "server.life.PlayerNPC",
      ].includes(host)
    ) {
      blockScript(
        context,
        declaration,
        `Remote Java service unavailable: ${host}; no local host access is authorized`,
      );
    }
    if (
      host &&
      (host === "server.ShopFactory" || node.kind === "var") &&
      parent?.type !== "Program" &&
      context.parents.get(parent)?.type !== "FunctionDeclaration"
    ) {
      blockScript(
        context,
        declaration,
        "Static host imports must execute directly at program/function entry",
      );
    }
    declare(
      context,
      node.kind === "var" ? context.scopeOwners.get(scope) : scope,
      declaration,
      node.kind,
    );
  }
}

function javaShopReceiver(node) {
  if (!call(node, "sendShop") || node.arguments.length !== 1) return null;
  const client = node.arguments[0],
    shop = node.callee.object;
  if (cmMethod(client) !== "getClient" || client.arguments.length !== 0) {
    return null;
  }
  return call(shop, "getShop") && shop.arguments.length === 1 ? shop : null;
}

function javaShopBinding(shop) {
  const instance = shop.callee.object;
  if (!call(instance, "getInstance") || instance.arguments.length !== 0) {
    return null;
  }
  return instance.callee.object.type === "Identifier"
    ? instance.callee.object
    : null;
}

/** Translate only the complete, exact server.ShopFactory chain; Java is never run. */
export function staticJavaShop(context, scope, node) {
  const shop = javaShopReceiver(node);
  if (!shop) return null;
  const binding = javaShopBinding(shop),
    id = integerLiteral(shop.arguments[0]);
  if (!binding || id === null || id <= 0) return null;
  const variable = resolveVariable(context, scope, binding);
  if (variable?.host !== "shop-factory") return null;
  if (
    variable.owner === context.scopeOwners.get(scope) &&
    variable.declarationEnd > node.start
  ) {
    return null;
  }
  return {
    shopId: id,
    translation:
      "server.ShopFactory.getInstance().getShop(literal).sendShop(cm.getClient())",
  };
}

function loopInitializer(context, scope, node) {
  const declaration = node.init;
  if (
    declaration?.type !== "VariableDeclaration" ||
    !["var", "let"].includes(declaration.kind) ||
    declaration.declarations.length < 1 ||
    declaration.declarations.length > 4
  ) {
    return null;
  }
  const entry = declaration.declarations[0],
    from = integerLiteral(entry.init);
  if (entry.id.type !== "Identifier" || from === null || from < 0) return null;
  const variable = resolveVariable(context, scope, entry.id);
  return variable ? { variable, from } : null;
}

function safeLoopBody(node, name) {
  for (const child of astInventory(node.body)) {
    if (
      [
        "ForStatement",
        "WhileStatement",
        "DoWhileStatement",
        "FunctionDeclaration",
      ].includes(child.type)
    ) {
      return false;
    }
    if (child.type === "UpdateExpression" && child.argument.name === name) {
      return false;
    }
    if (child.type === "AssignmentExpression" && child.left.name === name) {
      return false;
    }
    if (child.type === "VariableDeclarator" && child.id.name === name) {
      return false;
    }
  }
  return true;
}

export function loopComparison(node) {
  const test = node.test;
  return test?.type === "LogicalExpression" && test.operator === "&&"
    ? test.right
    : test;
}

function canonicalProgress(node, name) {
  const test = loopComparison(node),
    update =
      node.update?.type === "SequenceExpression"
        ? node.update.expressions[0]
        : node.update;
  if (test?.type !== "BinaryExpression" || test.operator !== "<") return false;
  if (test.left.type !== "Identifier" || test.left.name !== name) return false;
  if (update?.type !== "UpdateExpression" || update.operator !== "++") {
    return false;
  }
  return update.argument.type === "Identifier" && update.argument.name === name;
}

function canonicalBound(node, from) {
  const maximum = integerLiteral(node);
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.name === "length"
  ) {
    return true;
  }
  return (
    maximum !== null &&
    maximum <= NPC_SCRIPT_LIMITS.loopIterations &&
    maximum >= from
  );
}
function safeLoopUpdates(node, name) {
  if (node.update?.type !== "SequenceExpression") return true;
  const updates = node.update.expressions;
  return (
    updates.length <= 4 &&
    updates
      .slice(1)
      .every(
        (update) =>
          update.type === "AssignmentExpression" &&
          update.left.type === "Identifier" &&
          update.left.name !== name,
      )
  );
}

/** Only canonical literal/array-bounded loops; every body operation is compiled separately. */
export function boundedLoop(context, scope, node) {
  const initial = loopInitializer(context, scope, node);
  if (!initial || !canonicalProgress(node, initial.variable.name)) return null;
  if (!canonicalBound(loopComparison(node).right, initial.from)) return null;
  if (!safeLoopBody(node, initial.variable.name)) return null;
  if (!safeLoopUpdates(node, initial.variable.name)) return null;
  return {
    from: initial.from,
    variable: initial.variable.key,
    maxIterations: NPC_SCRIPT_LIMITS.loopIterations,
  };
}
