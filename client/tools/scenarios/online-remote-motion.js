import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertion, failureDetails, measureStage } from "../native-evidence.js";
import { onlineIdentity } from "./online-lifecycle.js";
import {
  participant,
  ready,
  focusGame,
  consoleSection,
  details,
} from "./online-ui-repairs.js";
import { login } from "./online-recycling-scrolls.js";
import { reconnect } from "./online-latency.js";
import { clickLabel } from "./native.js";

const pause = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Observation only; all game actions use native keyboard/pointer controls. */
function sample() {
  const probe = { rows: [], running: true };
  window.__remoteProbe = probe;
  function frame() {
    if (!probe.running || probe.rows.length >= 600) return;
    const state = window.maple.snapshot();
    probe.rows.push({
      time: performance.now(),
      actors: state.actors.filter(
        (actor) => actor.kind === "drop" || actor.kind === "player",
      ),
      online: state.online.status,
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function finish(page, output, name) {
  const rows = await page.evaluate(() => {
    window.__remoteProbe.running = false;
    return window.__remoteProbe.rows;
  });
  await Bun.write(join(output, `${name}-frames.json`), JSON.stringify(rows));
  return rows;
}

async function walkAndJump([mover, observer], network, output) {
  await focusGame(mover);
  const id = await mover.evaluate(
    () => window.mapleOnline.observation().self.entity.id,
  );
  await observer.evaluate(sample);
  await mover.keyboard.down("ArrowRight");
  await pause(700);
  await mover.keyboard.down("AltLeft");
  await pause(90);
  await mover.keyboard.up("AltLeft");
  await observer.waitForFunction(
    (id) =>
      window.maple
        .snapshot()
        .actors.some((actor) => actor.id === id && actor.action === "jump"),
    {},
    id,
  );
  network.stall(450);
  await pause(500);
  await mover.keyboard.up("ArrowRight");
  await pause(1600);
  return analyze(await finish(observer, output, "peer"), id);
}

async function drop([mover, observer], network, output) {
  await consoleSection(mover, "character");
  await details(mover, "Conjure world item");
  await mover.type('#conjure-world-item input[type="search"]', "2000000");
  await mover.select(
    '[aria-label="Item to drop in front of character"]',
    "2000000",
  );
  await observer.evaluate(sample);
  await clickLabel(mover, "Drop chosen item in front");
  await observer.waitForFunction(() =>
    window.maple
      .snapshot()
      .actors.some((actor) => actor.kind === "drop" && actor.visible),
  );
  const id = await observer.evaluate(
    () =>
      window.maple.snapshot().actors.find((actor) => actor.kind === "drop").id,
  );
  network.stall(1200);
  await pause(2500);
  return analyze(await finish(observer, output, "drop"), id);
}

function analyze(rows, id) {
  let previous = null,
    maximumStep = 0,
    moving = 0,
    lateMoving = 0,
    changedAt = 0;
  let minimumY = Infinity,
    maximumY = -Infinity;
  const path = {
    heldFrames: 0,
    dryMovement: 0,
    queued: 0,
    snaps: 0,
    drainedAt: null,
  };
  for (const row of rows) {
    const actor = row.actors.find((entry) => entry.id === id);
    if (!actor || !actor.visible) continue;
    minimumY = Math.min(minimumY, actor.renderY);
    maximumY = Math.max(maximumY, actor.renderY);
    if (previous) {
      const step = Math.hypot(
        actor.renderX - previous.renderX,
        actor.renderY - previous.renderY,
      );
      maximumStep = Math.max(maximumStep, step);
      if (actor.movePath) {
        analyzePath(path, actor, previous, row.time);
      }
      if (
        actor.observedX !== previous.observedX ||
        actor.observedY !== previous.observedY
      ) {
        changedAt = row.time;
      }
      if (step > 0.001) moving++;
      if (step > 0.001 && row.time - changedAt > 180) lateMoving++;
    } else changedAt = row.time;
    previous = actor;
  }
  return { id, maximumStep, moving, lateMoving, minimumY, maximumY, path };
}

function analyzePath(result, actor, previous, now) {
  const step = Math.hypot(
    actor.renderX - previous.renderX,
    actor.renderY - previous.renderY,
  );
  const path = actor.movePath;
  result.queued = Math.max(result.queued, path.queued);
  result.snaps = Math.max(result.snaps, path.backlogSnaps + path.capacitySnaps);
  if (
    result.drainedAt === null ||
    path.queued > 0 ||
    previous.movePath?.queued > 0 ||
    path.tick !== previous.movePath?.tick
  ) {
    result.drainedAt = now;
  }
  // A drained path still interpolates its final accepted quantum for up to 30 ms.
  // Packet age cannot identify exhaustion when a delayed burst is still playing.
  if (
    now - result.drainedAt > 60 &&
    actor.observedX === previous.observedX &&
    actor.observedY === previous.observedY
  ) {
    result.heldFrames++;
    result.dryMovement = Math.max(result.dryMovement, step);
  }
}

async function verifyReconnect([mover, observer]) {
  const initial = await mover.evaluate(
    () => window.mapleOnline.observation().self.entity,
  );
  await Promise.all([reconnect(observer), moveDuringReconnect(mover)]);
  const before = await mover.evaluate(
    () => window.mapleOnline.observation().self.entity,
  );
  assertion(
    Math.abs(before.position.x - initial.position.x) > 10,
    "Peer did not move during reconnect",
    { initial, before },
  );
  await observer.waitForFunction(
    (id) =>
      window.maple
        .snapshot()
        .actors.some(
          (actor) =>
            actor.id === id &&
            Math.abs(actor.x - actor.observedX) < 0.01 &&
            Math.abs(actor.y - actor.observedY) < 0.01 &&
            Math.abs(actor.renderX - actor.observedX) < 1 &&
            Math.abs(actor.renderY - actor.observedY) < 1,
        ),
    {},
    before.id,
  );
  const after = await observer.evaluate(
    (id) => window.maple.snapshot().actors.find((actor) => actor.id === id),
    before.id,
  );
  assertion(
    Math.hypot(
      after.renderX - before.position.x,
      after.renderY - before.position.y,
    ) < 1,
    "Reconnect did not restore the settled peer position",
    { before, after },
  );
  return { id: before.id, x: after.renderX, y: after.renderY };
}

async function moveDuringReconnect(mover) {
  await focusGame(mover);
  await mover.keyboard.down("ArrowLeft");
  await pause(600);
  await mover.keyboard.up("ArrowLeft");
  await pause(1100);
}

async function verify(pages, url, report) {
  for (const page of pages) await ready(page);
  assertion(report.errors.length === 0, "Browser errors", report.errors);
  assertion(
    (await onlineIdentity(url)).sourceBuildId === report.identity.sourceBuildId,
    "Source changed during check",
  );
  if (!report.baseline) {
    if (report.drop) {
      assertion(
        report.drop.lateMoving > 0,
        "Drop stopped animating while updates were held",
        report.drop,
      );
      assertion(
        report.drop.maximumY < 335,
        "Drop was projected below its landing floor",
        report.drop,
      );
    }
    assertion(
      report.peer.path.heldFrames > 0,
      "Dry movement path was not exercised",
      report.peer,
    );
    assertion(
      report.peer.path.dryMovement < 0.01,
      "Peer extrapolated an exhausted path",
      report.peer,
    );
    assertion(
      report.peer.path.queued > 1,
      "Delayed movement was not replayed as a queue",
      report.peer,
    );
    assertion(
      report.peer.path.snaps === 0,
      "Ordinary delay caused a recovery snap",
      report.peer,
    );
    assertion(
      report.peer.maximumStep < 20,
      "Peer snapped during ordinary movement",
      report.peer,
    );
  }
}

export async function runRemoteMotion({
  browser,
  url,
  network,
  output,
  baseline,
  scope = "all",
}) {
  await mkdir(output, { recursive: true });
  const report = {
    status: "running",
    baseline,
    scope,
    timings: {},
    errors: [],
    results: [],
  };
  const contexts = [],
    pages = [];
  try {
    report.identity = await measureStage(report.timings, "identity", () =>
      onlineIdentity(url),
    );
    for (const name of ["mover", "observer"]) {
      const page = await participant(browser, contexts, pages, report);
      await measureStage(report.timings, `${name}-login`, () =>
        login(page, url, name),
      );
    }
    report.peer = await measureStage(report.timings, "peer", () =>
      walkAndJump(pages, network, output),
    );
    if (scope === "all") {
      report.drop = await measureStage(report.timings, "drop", () =>
        drop(pages, network, output),
      );
    }
    report.reconnect = await measureStage(report.timings, "reconnect", () =>
      verifyReconnect(pages),
    );
    await verify(pages, url, report);
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure = failureDetails(error);
    for (const [index, page] of pages.entries()) {
      await page.screenshot({ path: join(output, `failure-${index}.png`) });
    }
  } finally {
    await measureStage(report.timings, "teardown", async () => {
      for (const context of contexts) await context.close();
    });
  }
  return report;
}
