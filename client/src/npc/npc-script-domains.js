/**
 * Finite integer domains of NPC IR expressions, shared by the compiler's
 * dependency closure and the browser/server admission proof. A warp such as
 * npc/2012006.js `cm.warp(200000110 + (sel * 10), "west00")` closes over every
 * value `sel` can hold: -1 (non-choice responses), each offered `#L` id, each
 * number-prompt value, and every authored assignment. The analysis is
 * flow-insensitive, so it is a superset; the runtime still checks every
 * computed id against the published set. Anything not provably finite is null.
 */
import { NPC_RUNTIME_LIMITS as LIMITS } from "./npc-script-values.js";

export const MAX_NPC_NUMERIC_DOMAIN = 256;
const SELECTION = "selection";
const ARITHMETIC = new Set(["+", "-", "*"]);

function remember(facts, name, value) {
  if (!facts.values.has(name)) facts.values.set(name, []);
  facts.values.get(name).push(value);
}

function numberPrompt(selection, node) {
  if (node.max - node.min >= MAX_NPC_NUMERIC_DOMAIN) selection.open = true;
  else {
    for (let value = node.min; value <= node.max; value++) {
      selection.base.push(value);
    }
  }
}

function bindingFact(facts, node) {
  if (node.op === "declare") {
    for (const entry of node.values) remember(facts, entry.name, entry.value);
  } else if (node.op === "assign" && node.operator === "=") {
    remember(facts, node.name, node.value);
  } else if (node.op === "assign" || node.op === "update") {
    facts.mutated.add(node.name);
  } else if (node.op === "for") {
    if (!facts.loops.has(node.variable)) facts.loops.set(node.variable, []);
    facts.loops.get(node.variable).push(node);
  }
}

function statementFact(facts, node) {
  bindingFact(facts, node);
  if (node.op === "dialog" && node.kind === "number") {
    numberPrompt(facts.selection, node);
  } else if (node.op === "call" && node.name === "action") {
    if (node.args.length > 2) facts.selection.inputs.push(node.args[2]);
  }
}

/** Statement facts the domains need: assignments, mutations, loops, prompts and calls. */
function programFacts(program, selectionKey) {
  const facts = {
    values: new Map(),
    mutated: new Set(),
    loops: new Map(),
    selection: { inputs: [], base: [-1], open: false },
    selectionKey,
  };
  for (const node of program.statements) statementFact(facts, node);
  for (const node of program.expressions) {
    if (node.op === "helper-set") remember(facts, node.name, node.value);
    if (node.op !== "helper") continue;
    node.args.forEach((arg, index) =>
      remember(facts, node.bindings[index], arg),
    );
  }
  if (selectionKey && facts.mutated.has(selectionKey)) {
    facts.selection.open = true;
  }
  facts.selection.inputs.push(...(facts.values.get(selectionKey) ?? []));
  choiceInputs(program, facts);
  return facts;
}

/** Offered `#L` ids: literal markers, or `"…#L" + id` with a finite right operand. */
function choiceInputs(program, facts) {
  const { selection } = facts,
    handled = new Set();
  for (const node of program.expressions) {
    if (node.op !== "binary" || node.operator !== "+") continue;
    const left = program.expressions[node.left];
    if (left?.op !== "literal" || !String(left.value).endsWith("#L")) continue;
    handled.add(node.left);
    const range = bodyRange(program, facts, node);
    if (range) selection.base.push(...range);
    else selection.inputs.push(node.right);
  }
  program.expressions.forEach((node, id) => {
    if (node.op !== "literal" || typeof node.value !== "string") return;
    for (const match of node.value.matchAll(/#L(\d+#)?/g)) {
      if (match[1]) selection.base.push(Number.parseInt(match[1], 10));
      else if (match.index + 2 !== node.value.length || !handled.has(id)) {
        selection.open = true;
      }
    }
  });
}

/** `"#L" + i` inside i's own loop offers only the body values, never the exit bound. */
function bodyRange(program, facts, concat) {
  const right = program.expressions[concat.right];
  if (right?.op !== "variable" || facts.mutated.has(right.name)) return null;
  const span = concat.source;
  const loop = facts.loops
    .get(right.name)
    ?.find(
      (node) => node.source.start <= span.start && span.end <= node.source.end,
    );
  return loop ? loopRange(program, facts, loop, true) : null;
}

function loopTest(program, loop) {
  const outer = program.expressions[loop.test];
  const test =
    outer?.op === "logical" && outer.operator === "&&"
      ? program.expressions[outer.right]
      : outer;
  return test?.op === "binary" && test.operator === "<" ? test : null;
}

/** Longest authored literal array a `.length` bound can read. */
function arrayBound(program, facts, bound) {
  const array = program.expressions[bound.value];
  if (array?.op !== "variable" || facts.mutated.has(array.name)) return null;
  const arrays = (facts.values.get(array.name) ?? []).map(
    (id) => program.expressions[id],
  );
  if (!arrays.length || !arrays.every((node) => node.op === "array")) {
    return null;
  }
  return Math.max(...arrays.map((node) => node.values.length));
}

function loopBound(program, facts, loop) {
  const bound = program.expressions[loopTest(program, loop)?.right];
  if (bound?.op === "literal" && Number.isSafeInteger(bound.value)) {
    return bound.value;
  }
  return bound?.op === "length" ? arrayBound(program, facts, bound) : null;
}

/** Literal or literal-array `.length` loop bound; outside the body the exit bound is included. */
function loopRange(program, facts, loop, body = false) {
  const maximum = loopBound(program, facts, loop);
  if (maximum === null || maximum - loop.from >= MAX_NPC_NUMERIC_DOMAIN) {
    return null;
  }
  const range = [];
  const last = body ? maximum - 1 : maximum;
  for (let value = loop.from; value <= last; value++) range.push(value);
  return range;
}

function expressionInputs(node) {
  if (node?.op === "literal") {
    return Number.isSafeInteger(node.value)
      ? { base: [node.value], children: [], operator: null }
      : null;
  }
  if (node?.op === "binary" && ARITHMETIC.has(node.operator)) {
    return {
      base: [],
      children: [node.left, node.right],
      operator: node.operator,
    };
  }
  if (node?.op === "conditional") {
    return { base: [], children: [node.yes, node.no], operator: null };
  }
  return null;
}

/** One node's literal base values and child keys, or null when not finite. */
function domainInputs(program, facts, key) {
  if (key === SELECTION) {
    const { selection } = facts;
    return selection.open
      ? null
      : { base: selection.base, children: selection.inputs, operator: null };
  }
  const node = program.expressions[key];
  if (node?.op === "variable" || node?.op === "helper-value") {
    return variableInputs(program, facts, node.name);
  }
  return expressionInputs(node);
}

function variableInputs(program, facts, name) {
  if (name === facts.selectionKey) {
    return { base: [], children: [SELECTION], operator: null };
  }
  const children = facts.values.get(name) ?? [];
  if (facts.mutated.has(name)) return null;
  if (!facts.loops.has(name)) {
    return children.length ? { base: [], children, operator: null } : null;
  }
  const base = [];
  for (const loop of facts.loops.get(name)) {
    const range = loopRange(program, facts, loop);
    if (!range) return null;
    base.push(...range);
  }
  return { base, children, operator: null };
}

function combine(inputs, domains) {
  const result = new Set(inputs.base);
  if (!inputs.operator) {
    for (const domain of domains) for (const value of domain) result.add(value);
    return result;
  }
  for (const left of domains[0]) {
    for (const right of domains[1]) {
      const value =
        inputs.operator === "+"
          ? left + right
          : inputs.operator === "-"
            ? left - right
            : left * right;
      if (!Number.isSafeInteger(value)) return null;
      result.add(value);
    }
  }
  return result;
}

/** Enter a node (push its children) or leave it (combine them); false when not finite. */
function visit(program, walk, { key, leave }) {
  const inputs = domainInputs(program, walk.facts, key);
  if (!inputs) return false;
  if (!leave) {
    if (walk.active.has(key)) return false;
    walk.active.add(key);
    walk.pending.push({ key, leave: true });
    for (const child of inputs.children) {
      if (!walk.memo.has(child)) {
        walk.pending.push({ key: child, leave: false });
      }
    }
    return true;
  }
  const domain = combine(
    inputs,
    inputs.children.map((child) => walk.memo.get(child)),
  );
  if (!domain || domain.size > MAX_NPC_NUMERIC_DOMAIN) return false;
  walk.active.delete(key);
  walk.memo.set(key, domain);
  return true;
}

/** Postorder, nonrecursive evaluation; cycles and oversized products are null. */
export function npcNumericDomain(program, expression) {
  const selectionKey = program.functions?.action?.parameters?.[2] ?? null;
  const walk = {
    facts: programFacts(program, selectionKey),
    memo: new Map(),
    active: new Set(),
    pending: [{ key: expression, leave: false }],
  };
  for (let steps = 0; walk.pending.length; steps++) {
    const item = walk.pending.pop();
    if (walk.memo.has(item.key) && !item.leave) continue;
    if (steps > LIMITS.analysisSteps || !visit(program, walk, item)) {
      return null;
    }
  }
  return walk.memo.get(expression) ?? null;
}
