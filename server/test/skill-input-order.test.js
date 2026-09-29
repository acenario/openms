import { expect, test } from "bun:test";
import { awaitSkillInput } from "../src/skill-input-order.js";

function fixture() {
  return {
    field: { tick: 10 },
    connection: {},
    ackInputSeq: 0,
    inputQueue: new Map([[11, { inputSeq: 1, jump: true, impulses: [] }]]),
  };
}

test("airborne skill admission waits for accepted jump input, not its old field tick", async () => {
  const actor = fixture();
  let admitted = false;
  const pending = awaitSkillInput({}, actor).then(() => {
    admitted = true;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  actor.field.tick = 100;
  await new Promise((resolve) => {
    setTimeout(resolve, 35);
  });
  expect(admitted).toBe(false);
  actor.ackInputSeq = 1;
  await pending;
  expect(admitted).toBe(true);
});

test("a field change during input admission cannot cast in the new field", async () => {
  const actor = fixture();
  const pending = awaitSkillInput({}, actor);
  actor.field = { tick: 12 };
  await expect(pending).rejects.toThrow("STALE_FIELD");
});

test("paused or overloaded fields reject instead of leaving a movement cast pending", async () => {
  const actor = fixture();
  actor.field.paused = true;
  await expect(awaitSkillInput({}, actor)).rejects.toThrow("SERVER_BUSY");
  actor.field.paused = false;
  await expect(awaitSkillInput({ overloaded: true }, actor)).rejects.toThrow(
    "SERVER_BUSY",
  );
});

test("cast admission stops before the impulse it must authorize", async () => {
  const actor = fixture();
  actor.ackInputSeq = 1;
  actor.inputQueue.set(12, {
    inputSeq: 2,
    impulses: [{ id: null, source: "skill", skillId: 4121006 }],
  });
  actor.inputQueue.set(13, { inputSeq: 3, impulses: [] });
  await awaitSkillInput({}, actor, 4121006);
  expect(actor.movementBarrier).toBe(1);
  expect(actor.ackInputSeq).toBe(1);
});
