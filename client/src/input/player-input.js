import {
  createDefaultBindings,
  heldActionForCode,
  PHYSICAL_CODES,
} from "./keymap.js";
import { appendAttackEvent } from "../skills/aran-input.js";

/** Native pointer focus restores the canvas after browser controls. */
function focusCanvas(event) {
  event.currentTarget.focus({ preventScroll: true });
}

function recompute(context) {
  const input = context.input;
  input.left = false;
  input.right = false;
  input.up = false;
  input.down = false;
  input.jump = context.tappedJump;
  input.attack = context.tappedAttack;
  for (let index = 0; index < PHYSICAL_CODES.length; index++) {
    if (!context.held[index]) continue;
    const action = actionForCode(context, PHYSICAL_CODES[index]);
    if (action) input[action] = true;
  }
}

function actionForCode(context, code) {
  return context.bindings
    ? context.bindings.actionForCode(code)
    : heldActionForCode(code, context.defaults);
}

/** Command's own press carries metaKey; other keys held with it stay browser shortcuts. */
function commandCombination(event) {
  return (
    event.metaKey && event.code !== "MetaLeft" && event.code !== "MetaRight"
  );
}

function press(context, event) {
  if (event.defaultPrevented || commandCombination(event)) return;
  const index = PHYSICAL_CODES.indexOf(event.code);
  if (index < 0) return;
  const action = actionForCode(context, event.code);
  if (!action) return;
  event.preventDefault();
  if (event.repeat && !context.held[index]) return;
  if (!context.held[index]) recordPress(context, action);
  context.held[index] = 1;
  recompute(context);
}

/** Record recognition edges before mutating physical holds, including overflow. */
function recordPress(context, action) {
  if (action !== "attack") appendAttackEvent(context.input, 0);
  if (context.input[action]) return;
  if (action === "jump") context.input.jumpPressed = true;
  if (action === "up") context.input.upPressed = true;
  if (action === "attack") appendAttackEvent(context.input, 1);
}

function release(context, event) {
  context.bindings?.releaseCode(event.code);
  const index = PHYSICAL_CODES.indexOf(event.code);
  if (index < 0) return;
  const wasAttack = context.input.attack;
  if (context.held[index] && actionForCode(context, event.code) !== "attack") {
    appendAttackEvent(context.input, 0);
  }
  context.held[index] = 0;
  recompute(context);
  if (wasAttack && !context.input.attack) appendAttackEvent(context.input, 2);
}

function tapInput(context, action) {
  if (action === "jump") {
    context.tappedJump = true;
    context.input.jumpPressed = true;
  } else if (action === "attack") {
    if (!context.input.attack) appendAttackEvent(context.input, 1);
    context.tappedAttack = true;
  } else throw new TypeError("Only jump and attack have gameplay taps.");
  recompute(context);
}

/** Release taps only after clearing this tick's packet so release is next tick's edge. */
function finishInputTick(context) {
  context.input.jumpPressed = false;
  context.input.upPressed = false;
  context.input.attackEvents = 0;
  context.input.attackEventCount = 0;
  if (!context.tappedJump && !context.tappedAttack) return;
  const wasAttack = context.input.attack;
  context.tappedJump = false;
  context.tappedAttack = false;
  recompute(context);
  if (wasAttack && !context.input.attack) appendAttackEvent(context.input, 2);
}

function createInputContext() {
  return {
    input: {
      left: false,
      right: false,
      up: false,
      down: false,
      jump: false,
      attack: false,
      jumpPressed: false,
      upPressed: false,
      attackEvents: 0,
      attackEventCount: 0,
    },
    held: new Uint8Array(PHYSICAL_CODES.length),
    bindingActions: new Array(PHYSICAL_CODES.length).fill(null),
    defaults: createDefaultBindings(),
    bindings: null,
    unsubscribe: null,
    tappedJump: false,
    tappedAttack: false,
    generation: 0,
  };
}

/** Reset physical and tap state, advancing the epoch only on an actual clear. */
function clearInput(context, event) {
  if (event?.type === "visibilitychange" && !globalThis.document?.hidden) {
    return;
  }
  context.bindings?.releaseAllSkills();
  context.generation++;
  context.held.fill(0);
  context.tappedJump = false;
  context.tappedAttack = false;
  recompute(context);
  context.input.jumpPressed = false;
  context.input.upPressed = false;
  context.input.attackEvents = 3;
  context.input.attackEventCount = 1;
}

/** Save-status notifications must not erase a human hold after agent takeover.
 * Only a changed motion binding map invalidates physical input ownership. */
function refreshBindingActions(context) {
  const active = context.bindings?.active ?? context.defaults;
  let changed = false;
  for (let index = 0; index < PHYSICAL_CODES.length; index++) {
    const action = heldActionForCode(PHYSICAL_CODES[index], active);
    if (action !== context.bindingActions[index]) changed = true;
    context.bindingActions[index] = action;
  }
  return changed;
}

/**
 * Preallocated physical holds preserve modifier aliases until both sides release.
 * keyDown/keyUp accept native events or admitted event-like key objects; down
 * edges remain held until keyUp/clear, including across the next physics tick.
 * @param {HTMLCanvasElement} canvas Native keyboard/focus target.
 */
export function createPlayerInput(canvas) {
  const context = createInputContext();
  const keyDown = press.bind(null, context);
  const keyUp = release.bind(null, context);
  const clear = clearInput.bind(null, context);
  const tap = tapInput.bind(null, context);
  const afterTick = finishInputTick.bind(null, context);
  function bindingsChanged() {
    if (refreshBindingActions(context)) clear();
  }
  function setBindings(service, preserve = false) {
    if (!preserve) context.bindings?.releaseAllSkills();
    context.unsubscribe?.();
    context.bindings = service;
    context.unsubscribe = service ? service.subscribe(bindingsChanged) : null;
    refreshBindingActions(context);
    if (!preserve) clear();
  }
  function destroy() {
    attachInput(canvas, handlers, false);
    context.unsubscribe?.();
    clear();
  }
  const handlers = { keydown: keyDown, keyup: keyUp, clear };
  attachInput(canvas, handlers, true);
  return {
    state: context.input,
    /** Clear epoch lets action adapters discard consumed UI-key holds as well. */
    get generation() {
      return context.generation;
    },
    keyDown,
    keyUp,
    clear,
    checkpoint() {
      return {
        input: { ...context.input },
        held: Array.from(context.held),
        tappedJump: context.tappedJump,
        tappedAttack: context.tappedAttack,
        generation: context.generation,
      };
    },
    /** Internal retained-state rollback only; imported dumps never enter this method. */
    restore(checkpoint) {
      context.held.set(checkpoint.held);
      context.tappedJump = checkpoint.tappedJump;
      context.tappedAttack = checkpoint.tappedAttack;
      context.generation = checkpoint.generation;
      Object.assign(context.input, checkpoint.input);
    },
    setBindings,
    tap,
    afterTick,
    destroy,
  };
}

function attachInput(canvas, handlers, attach) {
  if (attach) {
    canvas.addEventListener("keydown", handlers.keydown);
    window.addEventListener("keyup", handlers.keyup);
    window.addEventListener("blur", handlers.clear);
    canvas.addEventListener("blur", handlers.clear);
    globalThis.document?.addEventListener("visibilitychange", handlers.clear);
    canvas.addEventListener("pointerdown", focusCanvas);
  } else {
    canvas.removeEventListener("keydown", handlers.keydown);
    window.removeEventListener("keyup", handlers.keyup);
    window.removeEventListener("blur", handlers.clear);
    canvas.removeEventListener("blur", handlers.clear);
    globalThis.document?.removeEventListener(
      "visibilitychange",
      handlers.clear,
    );
    canvas.removeEventListener("pointerdown", focusCanvas);
  }
}
