import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertion, failureDetails, measureStage } from "../native-evidence.js";
import { statistics } from "../validation-metrics.js";
import { onlineIdentity } from "./online-lifecycle.js";
import { participant, focusGame } from "./online-ui-repairs.js";
import { login } from "./online-recycling-scrolls.js";
import { clickLabel } from "./native.js";

const CAPACITY = 1200;
const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Read-only frame sampling, including tick regressions hidden by counter resets. */
function sampleFrames(capacity) {
  const sample = { rows: [], overflow: 0, running: true };
  window.__skillMotionProbe = sample;
  function frame(time) {
    if (!sample.running) return;
    const state = window.maple.snapshot();
    const sim = state.simulation;
    const prediction = state.prediction;
    if (sample.rows.length < capacity) {
      sample.rows.push({
        time,
        x: sim.x,
        y: sim.y,
        vx: sim.vx,
        vy: sim.vy,
        tick: prediction.predictedTick,
        ready: prediction.ready,
        corrections: prediction.corrections,
        loading: state.loading,
        pending: prediction.pendingImpulses,
        visuals: state.skillVisuals,
        localVisuals: state.localSkillFeedback,
      });
    } else sample.overflow++;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function observeWire(page, report) {
  const wire = await page.createCDPSession();
  await wire.send("Network.enable");
  wire.on("Network.webSocketFrameReceived", ({ response }) => {
    const message = JSON.parse(response.payloadData);
    if (report.wire.length >= CAPACITY) throw new Error("Wire probe capacity");
    if (message.type === "motion") {
      report.wire.push({
        type: "motion",
        tick: message.serverTick,
        authoritative: message.authoritative,
        diverts: message.diverts,
        motion: message.motion,
        motionEpoch: message.motionEpoch,
        ackInputSeq: message.ackInputSeq,
      });
    } else if (["snapshot", "result"].includes(message.type)) {
      report.wire.push({
        type: message.type,
        tick: message.serverTick,
        status: message.status,
        code: message.code,
      });
    }
  });
}

async function casts(page, report, output) {
  await clickLabel(page, "Minimize minimap");
  await focusGame(page);
  await page.waitForFunction(
    () => window.maple.snapshot().simulation.state === "ground",
  );
  await waitForCommands(page);
  await page.evaluate(sampleFrames, CAPACITY);
  const keys = [
    "ArrowRight",
    "ArrowLeft",
    "ArrowRight",
    "ArrowRight",
    "ArrowLeft",
  ];
  for (const key of keys) {
    const rapid = report.casts.length >= 3;
    await page.keyboard.down(key);
    await page.keyboard.down("Space");
    await delay(rapid ? 30 : 90);
    await page.waitForFunction(
      () => window.maple.snapshot().simulation.state === "air",
    );
    await page.keyboard.up("Space");
    if (!rapid) await delay(90);
    const before = await page.evaluate(
      () => window.maple.snapshot().prediction.predictedTick,
    );
    await page.keyboard.press("d");
    await delay(60);
    report.casts.push(
      await page.evaluate(
        (tick) => ({
          tick,
          simulation: window.maple.snapshot().simulation,
          prediction: window.maple.snapshot().prediction,
        }),
        before,
      ),
    );
    if (rapid) {
      await page.screenshot({
        path: join(output, `cast-${report.casts.length}.png`),
      });
    } else await delay(700);
    await page.waitForFunction(
      () => window.maple.snapshot().simulation.state === "ground",
    );
    await page.keyboard.up(key);
    if (!rapid) await delay(200);
    if (report.roundTripMs) {
      await waitForCommands(page);
    }
  }
  await delay(report.roundTripMs + 100);
  return page.evaluate(() => {
    window.__skillMotionProbe.running = false;
    return window.__skillMotionProbe;
  });
}

async function waitForCommands(page) {
  await page.waitForFunction(
    () => window.mapleOnline.snapshot().pendingOperations === 0,
  );
}

/** Fixed WZ effects stay at the cast origin, including a reuse before expiry. */
function analyzeVisuals(samples) {
  const playbacks = new Set();
  const localPlaybacks = new Set();
  let previous = new Map(),
    maxOffset = 0,
    retainedRestarts = 0;
  for (const row of samples.rows) {
    const current = new Map();
    for (const visual of row.localVisuals) {
      if (visual.skillId === 4111006 && visual.visualPlayed && visual.visible) {
        localPlaybacks.add(visual.operationId);
      }
    }
    for (const visual of row.visuals) {
      if (visual.sourceId !== "skill:world:Flying:" || !visual.visible) {
        continue;
      }
      current.set(visual.id, visual.playbackId);
      playbacks.add(`${visual.id}:${visual.playbackId}`);
      if (
        previous.has(visual.id) &&
        previous.get(visual.id) !== visual.playbackId
      ) {
        retainedRestarts++;
      }
      maxOffset = Math.max(
        maxOffset,
        Math.hypot(
          visual.position.x - Math.trunc(visual.target.x),
          visual.position.y - Math.trunc(visual.target.y),
        ),
      );
    }
    previous = current;
  }
  return {
    playbacks: playbacks.size,
    localPlaybacks: localPlaybacks.size,
    retainedRestarts,
    maxOffset,
  };
}

function analyze(samples) {
  const intervals = [];
  let regressions = 0,
    notReady = 0,
    loading = 0,
    maxHoldMs = 0,
    heldSince = 0;
  for (let i = 1; i < samples.rows.length; i++) {
    const row = samples.rows[i],
      prev = samples.rows[i - 1];
    intervals.push(row.time - prev.time);
    if (row.tick < prev.tick) regressions++;
    if (!row.ready) notReady++;
    if (row.loading) loading++;
    if (row.tick !== prev.tick) heldSince = row.time;
    else if (heldSince) maxHoldMs = Math.max(maxHoldMs, row.time - heldSince);
  }
  return {
    frames: samples.rows.length,
    intervals: statistics(intervals),
    regressions,
    notReady,
    loading,
    maxHoldMs,
    overflow: samples.overflow,
  };
}

/** Profile native airborne casts through the actual server and received snapshots. */
export async function runSkillMotion({ browser, url, output, network }) {
  await mkdir(output, { recursive: true });
  const report = {
    status: "running",
    roundTripMs: network?.roundTripMs ?? 0,
    timings: {},
    errors: [],
    results: [],
    casts: [],
    wire: [],
  };
  const contexts = [],
    pages = [];
  try {
    report.identity = await onlineIdentity(url);
    const page = await participant(browser, contexts, pages, report);
    await observeWire(page, report);
    await measureStage(report.timings, "readiness", () =>
      login(page, url, "motion"),
    );
    report.wire.length = 0;
    const samples = await measureStage(report.timings, "casts", () =>
      casts(page, report, output),
    );
    report.analysis = analyze(samples);
    report.visuals = analyzeVisuals(samples);
    await Bun.write(join(output, "frames.json"), JSON.stringify(samples.rows));
    verify(report);
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure = failureDetails(error);
  } finally {
    await measureStage(report.timings, "teardown", async () => {
      for (const context of contexts) await context.close();
    });
    await Bun.write(
      join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}

function verify(report) {
  assertion(
    report.analysis.regressions === 0,
    "Skill snapshots reset the movement clock",
  );
  assertion(
    report.analysis.notReady === 0,
    "Skill snapshots suspend prediction",
  );
  assertion(report.analysis.loading === 0, "Skill snapshots block gameplay");
  assertion(
    report.results.filter(
      (m) => m.value?.kind === "skill.cast" && m.status === "committed",
    ).length >= 5,
    "Five Flash Jumps did not commit",
  );
  assertion(
    report.casts
      .slice(0, 3)
      .every((cast) => Math.abs(cast.simulation.vx) > 400),
    "Flash Jump did not start immediately at its learned rank",
  );
  assertion(
    !report.wire.some((message) => message.authoritative),
    "Ordinary casts took ownership of client position",
  );
  assertion(report.errors.length === 0, "Browser errors");
  assertion(
    Math.max(report.visuals.playbacks, report.visuals.localPlaybacks) === 5,
    "Missing Flash Jump artwork",
  );
  assertion(
    report.roundTripMs > 0 ||
      report.visuals.localPlaybacks === 5 ||
      report.visuals.retainedRestarts > 0,
    "Consecutive effect reuse was not exercised",
  );
  assertion(
    report.visuals.maxOffset === 0,
    "Replayed Flash Jump slid from its previous cast origin",
  );
}
