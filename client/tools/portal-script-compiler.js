import { astInventory } from "./npc-script-ir.js";
import { compileNpcScript } from "./npc-script-compiler.js";
import { npcRemoteService } from "./npc-script-services.js";

/** PortalPlayerInteraction members whose NPC lowering is the same inherited
 *  AbstractPlayerInteraction method (or PortalPlayerInteraction.playPortalSound).
 *  NPCConversationManager-only members (dialogs, dispose, getMeso, getText, shops,
 *  job changes) are absent: `pi` does not have them. */
const PORTAL_METHODS = new Set([
  "warp",
  "playPortalSound",
  "getPlayer",
  "getChar",
  "getJobId",
  "getJob",
  "getLevel",
  "getMap",
  "getMapId",
  "haveItem",
  "canHold",
  "getQuestStatus",
  "isQuestCompleted",
  "isQuestActive",
  "isQuestStarted",
]);

function portalError(node, message) {
  const error = new Error(message);
  error.pos = node.start;
  error.loc = node.loc.start;
  return error;
}

function enterFunction(root) {
  const entries = root.body.filter(
    (node) =>
      node.type === "FunctionDeclaration" &&
      ["enter", "start", "action"].includes(node.id?.name),
  );
  const enter = entries[0];
  if (
    entries.length !== 1 ||
    enter.id.name !== "enter" ||
    enter.params.length !== 1 ||
    enter.params[0].type !== "Identifier" ||
    enter.params[0].name !== "pi"
  ) {
    throw portalError(root, "Portal source requires one enter(pi) entrypoint");
  }
  return enter;
}

function piReceiverCall(node) {
  const callee = node.type === "CallExpression" ? node.callee : null;
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "pi"
  );
}

/** Rename one admitted pi.method(...) receiver to the NPC compiler's cm. */
function admitReceiverCall(node) {
  const callee = node.callee;
  // AbstractPlayerInteraction.hasItem(id[, quantity]) is haveItem(id, quantity ?? 1).
  if (callee.property.name === "hasItem") {
    callee.property = { ...callee.property, name: "haveItem" };
  }
  const method = callee.property.name;
  callee.object.name = "cm";
  if (!PORTAL_METHODS.has(method) && !npcRemoteService(node, true)) {
    throw portalError(node, `Unsupported portal call: pi.${method}`);
  }
}

function identifier(node, name) {
  return node.type === "Identifier" && node.name === name;
}

/** Every `pi` is the entry parameter or the receiver of an admitted call. */
function admitReceivers(nodes, enter) {
  const bound = nodes.find((node) => identifier(node, "cm"));
  if (bound) throw portalError(bound, "Portal source already binds cm");
  for (const node of nodes) if (piReceiverCall(node)) admitReceiverCall(node);
  const loose = nodes.find(
    (node) => identifier(node, "pi") && node !== enter.params[0],
  );
  if (loose) throw portalError(loose, "pi may only be a method receiver");
}

/** PortalScriptManager discards enter's boolean; GenericPortal only re-enables
 *  client actions when it is false. A bare return ends the turn identically. */
function lowerReturns(enter) {
  for (const node of astInventory(enter.body)) {
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(node.type)
    ) {
      throw portalError(node, "Nested portal functions are unsupported");
    }
    if (node.type !== "ReturnStatement" || !node.argument) continue;
    if (
      node.argument.type !== "Literal" ||
      typeof node.argument.value !== "boolean"
    ) {
      throw portalError(node, "Portal enter must return a literal boolean");
    }
    node.argument = null;
  }
}

/** Rewrite the closed portal entry into the NPC compiler's start() shape. */
export function lowerPortalSource(root) {
  const enter = enterFunction(root);
  admitReceivers(astInventory(root), enter);
  lowerReturns(enter);
  enter.id = { ...enter.id, name: "start" };
  enter.params = [];
  return root;
}

/** Complete-source portal compilation through the NPC compiler, VM and admission. */
export function compilePortalScript(input) {
  return compileNpcScript({
    ...input,
    portal: true,
    lowerSource: lowerPortalSource,
  });
}
