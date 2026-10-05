import { expect, test } from "bun:test";
import { fixture } from "./party-fixture.js";
import { Participants } from "../src/participants.js";
import { advanceCombat } from "../src/field-combat.js";
import { combatOperation } from "../src/combat-rewards.js";

/** The database's revision admission: every committed transaction advances both counters. */
function revisionStore() {
  const receipts = new Map();
  return {
    validate() {},
    async receipt() {
      return null;
    },
    commit(actor, operation, mutator) {
      return this.commitMany([actor], operation, (drafts) =>
        mutator(drafts[0]),
      );
    },
    async commitMany(actors, operation, mutator) {
      if (receipts.has(operation.operationId)) {
        return receipts.get(operation.operationId);
      }
      const owner = actors[0];
      const current = () =>
        operation.domain === "inventory"
          ? owner.inventoryRevision
          : owner.revision;
      let receipt;
      if (current() !== operation.expectedRevision) {
        receipt = { status: "rejected", code: "STALE_REVISION" };
      } else {
        const drafts = actors.map((actor) => structuredClone(actor.profile));
        const result = (await mutator(drafts)) ?? {};
        if (result.code && result.code !== "OK") {
          receipt = { status: "rejected", code: result.code };
        } else {
          actors.forEach((actor, index) => {
            actor.profile = drafts[index];
            actor.revision++;
            actor.inventoryRevision++;
          });
          receipt = {
            status: "committed",
            code: "OK",
            transactionId: crypto.randomUUID(),
            value: result.value,
          };
          Object.defineProperty(receipt, "applied", { value: true });
        }
      }
      receipt.domainRevision = current();
      receipts.set(operation.operationId, receipt);
      return receipt;
    },
  };
}

/** A beginner whose field clock runs, so a cast's action occupies real time. */
async function hunting() {
  const { world, actors } = await fixture(0, [1000, 1001]);
  world.database = revisionStore();
  world.participants = new Participants(world);
  const [actor] = actors;
  Object.assign(actor, { inventoryRevision: 0, playSession: "play" });
  actor.connection = {
    data: { epoch: "connection", closed: false, ready: true },
  };
  const field = actor.field;
  const tick = () => {
    field.tick++;
    for (const peer of field.characters.values()) world.moveActor(peer);
    advanceCombat(world, field);
  };
  for (let count = 0; count < 100; count++) tick();
  const clock = setInterval(tick, 30);
  const cast = (skillId, expectedRevision) =>
    world.command(actor, {
      connectionEpoch: "connection",
      fieldEpoch: field.epoch,
      operationId: crypto.randomUUID(),
      expectedRevision,
      action: { kind: "skill.cast", skillId },
    });
  return { world, actor, cast, stop: () => clearInterval(clock) };
}

/** The client binds the second cast to the first receipt; it then waits for the first action. */
async function pipelined(probe, intervene) {
  const first = await probe.cast(1000, probe.actor.revision);
  expect(first.code).toBe("OK");
  expect(probe.actor.skillField.phase).not.toBe("idle");
  const second = probe.cast(1001, first.domainRevision);
  await intervene(probe);
  return await second;
}

test("a server-produced commit while a pipelined cast waits does not make it stale", async () => {
  const probe = await hunting();
  try {
    const second = await pipelined(probe, ({ world, actor }) =>
      world.participants.commitProduced(
        actor,
        combatOperation(actor, "combat.incoming"),
        () => [actor.id],
        () => ({ value: { kind: "combat.incoming", incomingId: "hit" } }),
      ),
    );
    expect([second.status, second.code]).toEqual(["committed", "OK"]);
  } finally {
    probe.stop();
  }
}, 10000);

test("a non-produced commit while a cast waits still makes it stale", async () => {
  const probe = await hunting();
  try {
    const second = await pipelined(probe, ({ world, actor }) =>
      world.participants.commit(
        actor,
        combatOperation(actor, "skill.profile"),
        [actor.id],
        () => ({ value: { kind: "skill.profile" } }),
      ),
    );
    expect(second.code).toBe("STALE_REVISION");
  } finally {
    probe.stop();
  }
}, 10000);
