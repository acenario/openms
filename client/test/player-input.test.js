import { test, expect } from "bun:test";
import { createPlayerInput } from "../src/input/player-input.js";
import { AranInput } from "../src/skills/aran-input.js";

function key(target, type, code, repeat = false) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code, repeat });
  target.dispatchEvent(event);
}

/** Native EventTargets exercise the keyboard boundary without a renderer or fake timing. */
function withInput(run) {
  const previous = globalThis.window;
  const windowTarget = new EventTarget();
  globalThis.window = windowTarget;
  const canvas = new EventTarget();
  const input = createPlayerInput(canvas);
  try {
    run(input, canvas, windowTarget);
  } finally {
    input.destroy();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("Up tap survives keyup before the next gameplay update", () => {
  withInput((input, canvas, windowTarget) => {
    key(canvas, "keydown", "ArrowUp");
    key(windowTarget, "keyup", "ArrowUp");
    expect(input.state.up).toBe(false);
    expect(input.state.upPressed).toBe(true);
    input.clear();
    expect(input.state.upPressed).toBe(false);
  });
});

test("focus or map clearing does not rearm held keys on OS repeat", () => {
  withInput((input, canvas, windowTarget) => {
    key(canvas, "keydown", "ArrowUp");
    input.clear();
    key(canvas, "keydown", "ArrowUp", true);
    expect(input.state.up).toBe(false);
    expect(input.state.upPressed).toBe(false);
    key(windowTarget, "keyup", "ArrowUp");
    key(canvas, "keydown", "ArrowUp");
    expect(input.state.up).toBe(true);
    expect(input.state.upPressed).toBe(true);
  });
});

test("both modifier sides share the native action without releasing each other's hold", () => {
  withInput((input, canvas, windowTarget) => {
    key(canvas, "keydown", "ControlLeft");
    key(canvas, "keydown", "ControlRight");
    key(windowTarget, "keyup", "ControlLeft");
    expect(input.state.attack).toBe(true);
    key(windowTarget, "keyup", "ControlRight");
    expect(input.state.attack).toBe(false);
    key(canvas, "keydown", "AltRight");
    key(windowTarget, "keyup", "AltRight");
    expect(input.state.jumpPressed).toBe(true);
    input.afterTick();
    expect(input.state.jumpPressed).toBe(false);
  });
});

test("macOS Command shares the Control record but its shortcuts stay with the browser", () => {
  withInput((input, canvas, windowTarget) => {
    const command = new Event("keydown", { cancelable: true });
    Object.assign(command, { code: "MetaLeft", repeat: false, metaKey: true });
    canvas.dispatchEvent(command);
    expect(command.defaultPrevented).toBe(true);
    expect(input.state.attack).toBe(true);
    const shortcut = new Event("keydown", { cancelable: true });
    Object.assign(shortcut, { code: "KeyR", repeat: false, metaKey: true });
    canvas.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    key(windowTarget, "keyup", "MetaLeft");
    expect(input.state.attack).toBe(false);
  });
});

test("quickslot taps last one gameplay step without cancelling a real held key", () => {
  withInput((input, canvas, windowTarget) => {
    input.tap("attack");
    expect(input.state.attack).toBe(true);
    input.afterTick();
    expect(input.state.attack).toBe(false);
    key(canvas, "keydown", "ControlLeft");
    input.tap("attack");
    input.afterTick();
    expect(input.state.attack).toBe(true);
    key(windowTarget, "keyup", "ControlLeft");
    expect(input.state.attack).toBe(false);
  });
});

function swingController() {
  const admitted = [];
  const field = {
    phase: "idle",
    dead: false,
    simulation: { seat: null },
    store: { profile: { job: 2112 } },
    combat: { weaponType: 44 },
    attackSkill: null,
    attackName: null,
    hooks: {
      skillLevel: () => 1,
      activateSkill(id) {
        admitted.push(id);
        field.attackSkill = { id };
        field.phase = "attack";
        return { ok: true };
      },
    },
    beginAttack() {
      this.phase = "attack";
      this.attackName = "swingT2PoleArm";
      this.attackSkill = null;
    },
  };
  return { field, admitted, controller: new AranInput(field) };
}

test("Control transitions between ticks buffer Double then Triple, not OS repeats", () => {
  withInput((input, canvas, windowTarget) => {
    const { controller, field, admitted } = swingController();
    key(canvas, "keydown", "ControlLeft");
    controller.input(30, input.state);
    input.afterTick();
    key(canvas, "keydown", "ControlLeft", true);
    controller.input(30, input.state);
    input.afterTick();
    field.phase = "idle";
    expect(controller.advance()).toBe(false);
    field.phase = "attack";
    key(windowTarget, "keyup", "ControlLeft");
    key(canvas, "keydown", "ControlLeft");
    key(windowTarget, "keyup", "ControlLeft");
    key(canvas, "keydown", "ControlLeft");
    controller.input(30, input.state);
    expect(controller.advance()).toBe(false);
    field.phase = "idle";
    expect(controller.advance()).toBe(true);
    field.phase = "idle";
    expect(controller.advance()).toBe(true);
    expect(admitted).toEqual([21000002, 21100001]);
  });
});

function doubleAt(delay, queuedAge, cancel = false) {
  const runtime = swingController();
  withInput((input, canvas, windowTarget) => {
    key(canvas, "keydown", "ControlLeft");
    runtime.controller.input(0, input.state);
    input.afterTick();
    key(windowTarget, "keyup", "ControlLeft");
    key(canvas, "keydown", "ControlLeft");
    runtime.controller.input(delay, input.state);
    input.afterTick();
    if (cancel) input.clear();
    runtime.controller.input(queuedAge, input.state);
    runtime.field.phase = "idle";
    runtime.controller.advance();
  });
  return runtime.admitted;
}

test("Double recognition includes480ms but the queued action expires at1000ms", () => {
  expect(doubleAt(480, 999)).toEqual([21000002]);
  expect(doubleAt(481, 0)).toEqual([]);
  expect(doubleAt(480, 1000)).toEqual([]);
});

test("focus cancellation discards a recognized follow-up rather than releasing it", () => {
  expect(doubleAt(300, 30, true)).toEqual([]);
});
