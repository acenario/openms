import {
  NPC_RUNTIME_LIMITS as LIMITS,
  npcBinary,
  npcUnary,
  npcNumber,
  npcValue,
  npcInteger,
  requireNpc,
} from "./npc-script-values.js";
import {
  applyNpcEffect,
  readNpcLocal,
  validateNpcMarkup,
} from "./npc-script-authority.js";

const UNINITIALIZED = Symbol("NPC lexical temporal dead zone");

function spend(turn) {
  requireNpc(
    ++turn.steps <= LIMITS.stepsPerTurn,
    "NPC callback exhausted its execution budget",
    "npc-budget",
  );
}

function variable(turn, name) {
  const table = name.startsWith("global:") ? turn.globals : turn.locals;
  requireNpc(
    Object.hasOwn(table, name),
    "NPC variable is outside the active scope",
  );
  requireNpc(
    table[name] !== UNINITIALIZED,
    "NPC lexical binding read before initialization",
    "npc-scope",
  );
  return table[name];
}

function assign(turn, name, value, initialize = false) {
  const table = name.startsWith("global:") ? turn.globals : turn.locals;
  requireNpc(
    Object.hasOwn(table, name),
    "NPC assignment is outside the active scope",
  );
  requireNpc(
    initialize || table[name] !== UNINITIALIZED,
    "NPC lexical binding assigned before initialization",
    "npc-scope",
  );
  table[name] = value;
}

/** One event-time scratch stack is reused by every expression in this callback. */
class Expressions {
  constructor(turn) {
    this.turn = turn;
    this.ids = new Int32Array(LIMITS.depth + 1);
    this.phases = new Uint8Array(LIMITS.depth + 1);
    this.cursors = new Uint16Array(LIMITS.depth + 1);
    this.saved = new Array(LIMITS.depth + 1);
    this.arguments = new Array(LIMITS.depth + 1);
    this.helperLocals = null;
    this.depth = -1;
    this.result = undefined;
  }

  push(id) {
    requireNpc(
      this.depth < LIMITS.depth - 1,
      "NPC expression depth exhausted",
      "npc-budget",
    );
    this.depth++;
    this.ids[this.depth] = id;
    this.phases[this.depth] = 0;
    this.cursors[this.depth] = 0;
  }

  finish(value) {
    this.result = npcValue(value);
    this.saved[this.depth] = undefined;
    this.arguments[this.depth] = undefined;
    this.depth--;
  }

  evaluate(id) {
    this.push(id);
    for (
      let count = 0;
      this.depth >= 0 && count < LIMITS.stepsPerTurn;
      count++
    ) {
      spend(this.turn);
      const node = this.turn.context.program.expressions[this.ids[this.depth]];
      this.step(node);
    }
    requireNpc(this.depth < 0, "NPC expression budget exhausted", "npc-budget");
    return this.result;
  }

  sequence(node) {
    const depth = this.depth,
      children = node.op === "array" ? node.values : node.args;
    if (this.phases[depth] === 0) {
      this.arguments[depth] = new Array(children.length);
      this.phases[depth] = 1;
    } else this.arguments[depth][this.cursors[depth]++] = this.result;
    if (this.cursors[depth] < children.length) {
      return this.push(children[this.cursors[depth]]);
    }
    const values = this.arguments[depth];
    this.finish(
      node.op === "array"
        ? Object.freeze(values)
        : readNpcLocal(this.turn, node.kind, values),
    );
  }

  unary(node) {
    if (this.phases[this.depth]++ === 0) return this.push(node.value);
    if (node.op === "unary") {
      return this.finish(npcUnary(node.operator, this.result));
    }
    requireNpc(
      typeof this.result === "string" || Array.isArray(this.result),
      "NPC length requires a string or immutable array",
      "npc-value",
    );
    this.finish(this.result.length);
  }

  binary(node) {
    const depth = this.depth,
      phase = this.phases[depth]++;
    if (phase === 0) {
      return this.push(node.op === "index" ? node.value : node.left);
    }
    if (phase === 1) {
      this.saved[depth] = this.result;
      if (
        node.op === "logical" &&
        (node.operator === "&&" ? !this.result : Boolean(this.result))
      ) {
        return this.finish(this.result);
      }
      return this.push(node.op === "index" ? node.index : node.right);
    }
    if (node.op === "logical") return this.finish(this.result);
    if (node.op !== "index") {
      return this.finish(
        npcBinary(node.operator, this.saved[depth], this.result),
      );
    }
    this.index(this.saved[depth]);
  }

  index(value) {
    requireNpc(
      typeof value === "string" || Array.isArray(value),
      "NPC index requires a bounded string or array",
      "npc-value",
    );
    const index = npcInteger(
      this.result,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    this.finish(index < 0 || index >= value.length ? undefined : value[index]);
  }

  conditional(node) {
    const phase = this.phases[this.depth]++;
    if (phase === 0) return this.push(node.test);
    if (phase === 1) return this.push(this.result ? node.yes : node.no);
    this.finish(this.result);
  }

  helper(node) {
    const depth = this.depth;
    if (this.phases[depth] === 2) {
      this.helperLocals = this.saved[depth];
      this.turn.callDepth--;
      return this.finish(this.result);
    }
    if (this.phases[depth] === 0) {
      this.arguments[depth] = new Array(node.args.length);
      this.phases[depth] = 1;
    } else this.arguments[depth][this.cursors[depth]++] = this.result;
    if (this.cursors[depth] < node.args.length) {
      return this.push(node.args[this.cursors[depth]]);
    }
    requireNpc(
      this.turn.callDepth < LIMITS.depth,
      "NPC call depth exhausted",
      "npc-budget",
    );
    this.turn.callDepth++;
    this.saved[depth] = this.helperLocals;
    this.helperLocals = Object.create(null);
    for (let index = 0; index < node.bindings.length; index++) {
      this.helperLocals[node.bindings[index]] = this.arguments[depth][index];
    }
    this.phases[depth] = 2;
    this.push(node.body);
  }

  helperValue(name) {
    requireNpc(
      this.helperLocals && Object.hasOwn(this.helperLocals, name),
      "NPC helper binding is outside the active frame",
      "npc-scope",
    );
    return this.helperLocals[name];
  }

  helperSet(node) {
    const phase = this.phases[this.depth]++;
    if (phase === 0) return this.push(node.value);
    if (phase === 1) {
      this.helperValue(node.name);
      this.helperLocals[node.name] = this.result;
      return this.push(node.body);
    }
    this.finish(this.result);
  }

  step(node) {
    switch (node.op) {
      case "array":
      case "read":
        return this.sequence(node);
      case "unary":
      case "length":
        return this.unary(node);
      case "binary":
      case "logical":
      case "index":
        return this.binary(node);
      case "conditional":
        return this.conditional(node);
      default:
        return this.stepValue(node);
    }
  }

  stepValue(node) {
    switch (node.op) {
      case "helper":
        return this.helper(node);
      case "helper-value":
        return this.finish(this.helperValue(node.name));
      case "helper-set":
        return this.helperSet(node);
      case "unavailable":
        requireNpc(
          false,
          `Remote NPC service unavailable: ${node.service}`,
          "npc-remote-service",
        );
        break;
      case "literal":
        return this.finish(node.value);
      case "undefined":
        return this.finish(undefined);
      case "variable":
        return this.finish(variable(this.turn, node.name));
      default:
        requireNpc(false, "Unknown NPC expression operation");
    }
  }
}

function choices(text) {
  const result = [],
    seen = new Set();
  for (const match of text.matchAll(/#L(\d+)#([\s\S]*?)(?:#l|(?=#L\d+#)|$)/g)) {
    requireNpc(
      result.length < LIMITS.arrayLength,
      "NPC choice count exceeds its bound",
      "npc-value",
    );
    const id = npcInteger(Number(match[1]), 0);
    requireNpc(
      !seen.has(id),
      "NPC menu contains duplicate selection IDs",
      "npc-value",
    );
    seen.add(id);
    result.push(Object.freeze({ id, text: match[2] }));
  }
  const starts = text.match(/#L\d+#/g) ?? [];
  requireNpc(
    result.length > 0 && starts.length === result.length,
    "NPC menu has invalid choice markers",
    "npc-value",
  );
  return Object.freeze(result);
}

function emitDialog(turn, node, text) {
  requireNpc(
    turn.view === null,
    "NPC callback emitted multiple views",
    "npc-output",
  );
  validateNpcMarkup(text, turn.context, turn.environment);
  const view = {
    kind: node.kind,
    text,
    speaker: node.speaker,
    npcId: turn.environment.npcId,
    rawType: node.rawType,
    internalType: node.internalType,
    source: node.source,
  };
  for (const key of [
    "prev",
    "next",
    "defaultValue",
    "min",
    "max",
    "minLength",
    "maxLength",
    "lengthPolicy",
  ]) {
    if (Object.hasOwn(node, key)) view[key] = node[key];
  }
  if (node.kind === "choice") view.choices = choices(text);
  turn.view = view;
}

function locals(program, name, args) {
  const definition = program.functions[name],
    result = Object.create(null);
  for (const key of definition.locals) result[key] = undefined;
  for (let index = 0; index < definition.parameters.length; index++) {
    result[definition.parameters[index]] = args[index];
  }
  return result;
}

/** Typed task stacks keep source control flow bounded, nonrecursive and allocation-light. */
class Statements {
  constructor(turn) {
    this.turn = turn;
    this.expressions = new Expressions(turn);
    this.ids = new Int32Array(LIMITS.statements + LIMITS.depth * 3);
    this.kinds = new Uint8Array(this.ids.length);
    this.iterations = new Uint16Array(this.ids.length);
    this.size = 0;
    this.frames = [];
  }

  push(id, kind = 0, iteration = 0) {
    requireNpc(
      this.size < this.ids.length,
      "NPC statement stack exhausted",
      "npc-budget",
    );
    this.ids[this.size] = id;
    this.kinds[this.size] = kind;
    this.iterations[this.size] = iteration;
    this.size++;
  }

  run(entry) {
    this.push(entry);
    for (let count = 0; this.size > 0 && count < LIMITS.stepsPerTurn; count++) {
      spend(this.turn);
      const index = --this.size,
        id = this.ids[index],
        kind = this.kinds[index];
      const node = this.turn.context.program.statements[id];
      if (kind === 1) this.loop(node, id, this.iterations[index]);
      else if (kind === 2) this.updateLoop(node, id, this.iterations[index]);
      else if (kind === 3) this.restoreFrame();
      else if (kind === 4) continue;
      else this.step(node, id);
    }
    requireNpc(this.size === 0, "NPC statement budget exhausted", "npc-budget");
  }

  loop(node, id, iteration) {
    if (!this.expressions.evaluate(node.test)) return;
    requireNpc(
      iteration < node.maxIterations,
      "NPC source loop exceeded its proved bound",
      "npc-budget",
    );
    this.push(id, 2, iteration);
    this.push(node.body);
  }

  updateLoop(node, id, iteration) {
    assign(
      this.turn,
      node.variable,
      npcValue(npcNumber(variable(this.turn, node.variable)) + 1),
    );
    this.push(id, 1, iteration + 1);
    if (node.after !== null) this.push(node.after);
  }

  arguments(refs) {
    const args = new Array(refs.length);
    for (let index = 0; index < refs.length; index++) {
      args[index] = this.expressions.evaluate(refs[index]);
    }
    return args;
  }

  callFunction(node) {
    requireNpc(
      this.turn.callDepth < LIMITS.depth,
      "NPC call depth exhausted",
      "npc-budget",
    );
    const args = this.arguments(node.args),
      program = this.turn.context.program;
    this.turn.callDepth++;
    this.frames.push({
      base: this.size,
      locals: this.turn.locals,
      scope: this.turn.scope,
    });
    this.turn.locals = locals(program, node.name, args);
    this.turn.scope = node.name;
    this.push(program.functions[node.name].entry, 3);
    this.push(program.functions[node.name].entry);
  }

  restoreFrame() {
    const frame = this.frames.pop();
    requireNpc(frame, "Invalid NPC call frame");
    this.turn.callDepth--;
    this.turn.locals = frame.locals;
    this.turn.scope = frame.scope;
  }

  returnFrame() {
    if (!this.frames.length) this.size = 0;
    else {
      this.size = this.frames[this.frames.length - 1].base;
      this.restoreFrame();
    }
  }

  breakControl() {
    for (let index = this.size - 1; index >= 0; index--) {
      if (this.kinds[index] === 3) break;
      if (this.kinds[index] !== 2 && this.kinds[index] !== 4) continue;
      this.size = index;
      return;
    }
    requireNpc(false, "NPC break outside its active loop/switch");
  }

  switchBranch(node, id) {
    const value = this.expressions.evaluate(node.test);
    this.resetLexicals(node.lexicals);
    let selected = -1,
      fallback = -1;
    for (let index = 0; index < node.cases.length; index++) {
      const branch = node.cases[index];
      if (branch.test === null) fallback = index;
      else if (this.expressions.evaluate(branch.test) === value) {
        selected = index;
        break;
      }
    }
    if (selected < 0) selected = fallback;
    if (selected < 0) return;
    this.push(id, 4);
    for (let index = node.cases.length - 1; index >= selected; index--) {
      this.push(node.cases[index].body);
    }
  }

  resetLexicals(names) {
    for (const name of names) assign(this.turn, name, UNINITIALIZED, true);
  }

  mutation(node) {
    if (node.op === "declare") {
      for (const entry of node.values) {
        assign(
          this.turn,
          entry.name,
          this.expressions.evaluate(entry.value),
          true,
        );
      }
    } else if (node.op === "update") {
      assign(
        this.turn,
        node.name,
        npcValue(npcNumber(variable(this.turn, node.name)) + node.delta),
      );
    } else {
      // Compound assignment reads its old LHS before evaluating its RHS.
      const old =
        node.operator === "=" ? undefined : variable(this.turn, node.name);
      const value = this.expressions.evaluate(node.value);
      assign(
        this.turn,
        node.name,
        node.operator === "=" ? value : npcBinary(node.operator[0], old, value),
      );
    }
  }

  step(node, id) {
    switch (node.op) {
      case "declare":
      case "assign":
      case "update":
        this.mutation(node);
        break;
      case "dialog":
        emitDialog(this.turn, node, this.expressions.evaluate(node.text));
        break;
      case "effect":
        applyNpcEffect(this.turn, node, this.arguments(node.args));
        break;
      case "shop":
        requireNpc(
          this.turn.view === null,
          "NPC callback emitted multiple views",
          "npc-output",
        );
        this.turn.view = {
          kind: "shop",
          shopId: node.shopId,
          npcId: this.turn.environment.npcId,
          source: node.source,
        };
        break;
      case "storage":
        requireNpc(
          this.turn.view === null,
          "NPC callback emitted multiple views",
          "npc-output",
        );
        requireNpc(
          node.npcId === this.turn.environment.npcId,
          "Storage NPC differs from the active interaction",
          "npc-ownership",
        );
        this.turn.view = {
          kind: "storage",
          npcId: node.npcId,
          source: node.source,
        };
        break;
      case "dispose":
        this.turn.disposed = true;
        // NPCScriptManager.dispose resets Character.useCS immediately.
        this.turn.craftingScroll = false;
        break;
      default:
        this.control(node, id);
    }
  }

  control(node, id) {
    switch (node.op) {
      case "unavailable":
        requireNpc(
          false,
          `Remote NPC service unavailable: ${node.service}`,
          "npc-remote-service",
        );
        break;
      case "block":
        this.pushBlock(node);
        break;
      case "if": {
        const branch = this.expressions.evaluate(node.test)
          ? node.yes
          : node.no;
        if (branch !== null) this.push(branch);
        break;
      }
      case "for":
        this.resetLexicals(node.lexicals);
        this.push(id, 1);
        this.push(node.init);
        break;
      case "switch":
        this.switchBranch(node, id);
        break;
      case "call":
        this.callFunction(node);
        break;
      case "return":
        this.returnFrame();
        break;
      case "break":
        this.breakControl();
        break;
      case "empty":
        break;
      default:
        requireNpc(false, "Unknown NPC statement operation");
    }
  }

  pushBlock(node) {
    this.resetLexicals(node.lexicals);
    for (let index = node.body.length - 1; index >= 0; index--) {
      this.push(node.body[index]);
    }
  }
}

/** Entire initial/start or action callback executes, including statements after dialog/dispose. */
export function executeNpcTurn(context, state, profile, input) {
  const turn = {
    // Dynamic return IDs originate only in the validated ledger, never mutate the admitted artifact.
    context: {
      ...context,
      dependencies: {
        ...context.dependencies,
        mapIds: new Set([
          ...context.dependencies.mapIds,
          ...(state.savedMapIds ?? []),
        ]),
      },
    },
    staticMapIds: context.dependencies.mapIds,
    environment: input.environment,
    profile,
    globals: { ...state.globals },
    locals: Object.create(null),
    scope: "global",
    inputText: input.text ?? state.inputText,
    craftingScroll: state.craftingScroll,
    disposed: false,
    view: null,
    effects: [],
    steps: 0,
    callDepth: 0,
    now: input.now,
  };
  const statements = new Statements(turn),
    program = context.program;
  if (input.start) {
    statements.run(program.initial);
    turn.scope = "start";
    turn.locals = locals(program, "start", []);
    statements.run(program.functions.start.entry);
  } else {
    requireNpc(
      program.functions.action,
      "NPC source has no action callback",
      "npc-response",
    );
    turn.scope = "action";
    turn.locals = locals(program, "action", input.args);
    statements.run(program.functions.action.entry);
  }
  // PortalScriptManager discards its interaction after enter(); a portal turn presents no view.
  requireNpc(
    !input.portal || turn.view === null,
    "Portal script emitted an NPC view",
    "npc-output",
  );
  if (!turn.view) {
    requireNpc(
      turn.disposed || input.portal === true,
      "NPC callback produced no view and did not dispose",
      "npc-output",
    );
    turn.view = { kind: "closed", npcId: input.environment.npcId };
  }
  turn.view.disposed = turn.disposed;
  return turn;
}
