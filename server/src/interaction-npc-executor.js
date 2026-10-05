import { Worker } from "node:worker_threads";
import { admitNpcScript } from "../../client/src/npc/npc-script-admission.js";
import {
  applyNpcEffect,
  admitNpcForceQuests,
  validateNpcEnvironment,
} from "../../client/src/npc/npc-script-authority.js";
import {
  interactionState,
  requireInteraction,
  sampleReader,
  INTERACTION_LIMITS,
} from "./interaction-common.js";
import { ruleError } from "./action-rules.js";

const CAPABILITIES = new Set([
  "item",
  "job",
  "reset-stats",
  "warp",
  "save-location",
  "saved-location-take",
  "crafting-scroll",
  "meso",
  "quest-start",
  "quest-complete",
]);

function workerFailure(code) {
  if (code === "npc-budget") return "SERVER_BUSY";
  if (
    [
      "npc-artifact",
      "npc-dependency",
      "npc-unsupported",
      "npc-output",
      "npc-profile",
    ].includes(code)
  ) {
    return "CONTENT_MISMATCH";
  }
  return ruleError({ code }).code;
}

/** A deadline terminates the actual interpreter thread, not only its awaiting Promise. */
export async function boundedNpcTurn(world, request) {
  const state = interactionState(world);
  requireInteraction(state.workers < INTERACTION_LIMITS.workers, "SERVER_BUSY");
  state.workers++;
  let worker;
  let timer;
  let termination;
  let settled = false;
  try {
    worker = new Worker(new URL("./interaction-worker.js", import.meta.url));
    return await new Promise((resolve, reject) => {
      function failed(code, reason) {
        if (settled) return;
        settled = true;
        world.log?.("npc.turn.failed", {
          source:
            request.environment.npcId ?? request.environment.portal?.script,
          code,
          reason,
        });
        const error = new Error(code, { cause: reason });
        error.code = code;
        reject(error);
      }
      timer = setTimeout(() => {
        // terminate starts immediately, before the rejection can release actor ownership.
        termination = worker.terminate();
        termination.catch(reject);
        failed("SERVER_BUSY");
      }, INTERACTION_LIMITS.workerMs);
      worker.once("error", (error) =>
        failed("CONTENT_MISMATCH", error.message),
      );
      worker.once("exit", (code) =>
        failed("CONTENT_MISMATCH", `Worker exited with code ${code}`),
      );
      worker.once("message", (response) => {
        if (!response?.ok) {
          return failed(workerFailure(response?.code), response?.reason);
        }
        settled = true;
        resolve(response.value);
      });
      worker.postMessage(request);
    });
  } finally {
    clearTimeout(timer);
    try {
      if (worker) await (termination ?? worker.terminate());
    } finally {
      state.workers--;
    }
  }
}

/** Apply admitted capability records to the transaction-owned profile draft. */
function replayCapabilities(turn, operations) {
  const { context, profile } = turn;
  for (const capability of operations) {
    requireInteraction(
      CAPABILITIES.has(capability.kind) &&
        Array.isArray(capability.args) &&
        capability.args.length <= 8,
      "CONTENT_MISMATCH",
    );
    if (capability.kind === "saved-location-take") {
      requireInteraction(
        Object.hasOwn(profile.savedLocations, capability.type) &&
          profile.savedLocations[capability.type] === capability.mapId,
        "REQUIREMENTS_NOT_MET",
      );
      context.dependencies.mapIds.add(capability.mapId);
      profile.savedLocations[capability.type] = null;
    } else applyNpcEffect(turn, capability, capability.args);
  }
}

/** Only typed, bounded trusted capabilities cross back; no arbitrary profile patch. */
export function replayNpcPlan(draft, request, result) {
  requireInteraction(
    Array.isArray(result.operations) &&
      result.operations.length <= INTERACTION_LIMITS.effects,
    "CONTENT_MISMATCH",
  );
  const context = admitNpcScript(request.compilation);
  for (const id of request.state?.savedMapIds ?? []) {
    context.dependencies.mapIds.add(id);
  }
  requireInteraction(
    Array.isArray(result.state.savedMapIds) &&
      result.state.savedMapIds.length <= 8192,
    "CONTENT_MISMATCH",
  );
  const saved = new Set(Object.values(draft.savedLocations));
  for (const id of result.state.savedMapIds) {
    requireInteraction(
      context.dependencies.mapIds.has(id) || saved.has(id),
      "CONTENT_MISMATCH",
    );
    context.dependencies.mapIds.add(id);
  }
  const environment = {
    ...request.environment,
    isCurrent: () => true,
    isBusy: () => false,
    prepareTravel: () => {
      throw new Error("Transition owner required");
    },
    random: sampleReader(request.samples),
  };
  validateNpcEnvironment(context, environment);
  admitNpcForceQuests(context, environment);
  const turn = {
    context,
    environment,
    profile: draft,
    now: request.now,
    effects: [],
    craftingScroll: request.state?.craftingScroll ?? false,
  };
  replayCapabilities(turn, result.operations);
  return result;
}
