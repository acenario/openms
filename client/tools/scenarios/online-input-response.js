import { assertion } from "../native-evidence.js";

const pause = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Read native key events; never alter input or advance the inspected simulation. */
export function observeInputResponse() {
  const probe = window.__walkMotionProbe;
  probe.edges = [];
  function record(event) {
    if (!probe.running) {
      window.removeEventListener("keydown", record, true);
      window.removeEventListener("keyup", record, true);
      return;
    }
    if (!event.isTrusted || event.repeat || probe.edges.length >= 64) return;
    if (!["ArrowRight", "ArrowLeft", "Space"].includes(event.code)) return;
    const state = window.maple.snapshot();
    probe.edges.push({
      at: performance.now(),
      code: event.code,
      type: event.type,
      x: state.presentation.x,
      y: state.presentation.y,
      vx: state.simulation.vx,
      facing: state.presentation.facing,
      jumpSequence: state.simulation.groundJumpSequence,
    });
  }
  window.addEventListener("keydown", record, true);
  window.addEventListener("keyup", record, true);
}

/** Starts, stops, reversal, then one held jump and six sub-quantum jump taps. */
export async function exerciseInputResponse(page, roundTripMs) {
  for (const key of ["ArrowRight", "ArrowLeft"]) {
    await page.keyboard.down(key);
    await pause(270);
    await page.keyboard.up(key);
    await pause(250);
  }
  await page.keyboard.down("ArrowRight");
  await pause(270);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("ArrowLeft");
  await pause(270);
  await page.keyboard.up("ArrowLeft");
  await pause(400);
  for (let index = 0; index < 7; index++) {
    await page.waitForFunction(
      () => window.maple.snapshot().simulation.state === "ground",
      { timeout: 3000 },
    );
    await page.keyboard.down("Space");
    await pause(index === 0 ? 90 : 8);
    await page.keyboard.up("Space");
    await pause(index === 0 ? roundTripMs + 1100 : 1100);
  }
  await pause(roundTripMs + 500);
}

function nextFrame(rows, edge, predicate) {
  for (const row of rows) {
    if (row.presentationAt < edge.at) continue;
    if (row.presentationAt > edge.at + 3000) break;
    if (predicate(row)) return row.presentationAt - edge.at;
  }
  return null;
}

export function analyzeInputResponse(rows, edges) {
  const responses = [];
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index];
    if (edge.type !== "keydown") continue;
    const release = edges[index + 1];
    if (edge.code === "Space") {
      responses.push({
        code: edge.code,
        duration: release?.at - edge.at,
        takeoffMs: nextFrame(rows, edge, (row) => row.y < edge.y - 1),
        // Only the first jump can be identified from the latest sound descriptor.
        soundMs: responses.some((response) => response.code === "Space")
          ? null
          : nextFrame(rows, edge, (row) => row.jumpSound),
      });
      continue;
    }
    const direction = edge.code === "ArrowRight" ? 1 : -1;
    responses.push({
      code: edge.code,
      facingMs: nextFrame(rows, edge, (row) => row.facing === direction),
      movingMs: nextFrame(
        rows,
        edge,
        (row) => direction * (row.x - edge.x) > 0.1,
      ),
      stoppingMs:
        edges[index + 2]?.at - release?.at < 50
          ? null
          : (nextFrame(rows, release, (row) => Math.abs(row.vx) < 0.001) ??
            Infinity),
    });
  }
  return responses;
}

export function verifyInputResponse(responses) {
  assertion(responses.length === 11, "Missing native input responses");
  const firstJump = responses.find((response) => response.code === "Space");
  assertion(
    firstJump.soundMs !== null && firstJump.soundMs < 100,
    "Jump sound waits for the network",
    firstJump,
  );
  for (const response of responses) {
    if (response.code === "Space") {
      assertion(
        response.takeoffMs !== null && response.takeoffMs < 100,
        "Native jump tap was lost or delayed",
        response,
      );
    } else {
      assertion(
        response.facingMs !== null && response.facingMs < 70,
        "Delayed direction change",
        response,
      );
      assertion(
        response.movingMs !== null && response.movingMs < 240,
        "Delayed horizontal response",
        response,
      );
      assertion(
        response.stoppingMs < 220,
        "Delayed movement release",
        response,
      );
    }
  }
}
