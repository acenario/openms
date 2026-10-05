import { protocolError } from "../../shared/schema.js";
import { scriptedPortalKind } from "../../client/src/world/portal-system.js";
import { npcReferences } from "./interaction-npc-content.js";
import { boundedNpcTurn } from "./interaction-npc-executor.js";
import { scriptProfile } from "./interaction-npc.js";
import {
  requireInteraction,
  serverRandomSamples,
} from "./interaction-common.js";

const PORTAL_EFFECTS = new Set(["warp", "portal-sound"]);

/** The extraction-compiled program for this exact authored portal source. */
async function portalCompilation(world, actor, script) {
  const references = await npcReferences(world);
  const compilation = Object.hasOwn(references.data.portalScripts ?? {}, script)
    ? references.data.portalScripts[script]
    : null;
  if (compilation?.status !== "supported") {
    actor.admission = "unsupported-content: server-script-unavailable";
    throw protocolError("REQUIREMENTS_NOT_MET");
  }
  requireInteraction(
    compilation.source?.path === `scripts/portal/${script}.js`,
    "CONTENT_MISMATCH",
  );
  return compilation;
}

/** No interacting NPC: original catalogs only, owned by the portal's source path. */
function portalEnvironment(world, script) {
  const catalog = world.content.catalog;
  return {
    portal: { script },
    items: catalog.ui.items,
    quests: catalog.quests,
    names: catalog.quests.strings,
    mapNames: catalog.mapNames,
  };
}

/** A view or any effect beyond one warp and its sound is outside portal authority. */
function portalOutcome(result) {
  requireInteraction(result.view?.kind === "closed", "CONTENT_MISMATCH");
  for (const effect of result.effects) {
    requireInteraction(PORTAL_EFFECTS.has(effect.kind), "CONTENT_MISMATCH");
  }
  const warp = result.effects.find((effect) => effect.kind === "warp");
  if (!warp) return null;
  return {
    mapId: warp.mapId,
    ...(warp.randomSpawn ? { randomSpawn: true } : { portal: warp.portal }),
    sound: result.effects.some((effect) => effect.kind === "portal-sound"),
  };
}

function sameDestination(first, second) {
  return (
    first?.mapId === second?.mapId &&
    first?.portal === second?.portal &&
    first?.randomSpawn === second?.randomSpawn &&
    first?.sound === second?.sound
  );
}

/**
 * Run an admitted sentinel portal script (GenericPortal.enterPortal ->
 * PortalScriptManager). A reached lazy trap rejects with no effect. Returns null
 * when the script ends without warping; otherwise its destination plus an
 * operation that re-runs the script against the transaction's fresh draft.
 */
export async function scriptedPortalTravel(world, actor, portal, operation) {
  const raw = actor.field.manifest.physics.map.$portalProperties?.[portal.id];
  const script = scriptedPortalKind(portal, raw ?? {});
  requireInteraction(script && !operation.mutate && !operation.ids);
  const compilation = await portalCompilation(world, actor, script);
  const field = actor.field;
  const run = async (profile) =>
    portalOutcome(
      await boundedNpcTurn(world, {
        compilation,
        environment: portalEnvironment(world, script),
        profile: scriptProfile(profile),
        input: { start: true, portal: true },
        now: Date.now(),
        samples: serverRandomSamples(),
      }),
    );
  const destination = await run(actor.profile);
  requireInteraction(
    actor.field === field && actor.state === "active",
    "STALE_FIELD",
  );
  if (!destination) return null;
  return {
    destination,
    operation: {
      ...operation,
      mutate: async (draft) => {
        requireInteraction(
          sameDestination(destination, await run(draft)),
          "REQUIREMENTS_NOT_MET",
        );
        return {};
      },
    },
  };
}
