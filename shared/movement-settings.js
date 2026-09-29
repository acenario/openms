import { SETTINGS_KEYS } from "./motion-schema.js";

const WORLD_KEYS = ["wingsX", "equipmentFs", "equipmentSwim"];
const FORM_KEYS = ["speed", "jump", "swim", "fs", "riding"];

/** Immutable, server-issued ability coefficients. No position or contact travels here. */
export function captureMovementSettings(sim) {
  return {
    effectiveSettings: { ...sim.effectiveSettings },
    worldMovement: {
      ...sim.worldMovement,
      form: sim.worldMovement.form ? { ...sim.worldMovement.form } : null,
    },
  };
}

export function sameMovementSettings(sim, configuration) {
  for (const key of SETTINGS_KEYS) {
    if (sim.effectiveSettings[key] !== configuration.effectiveSettings[key]) {
      return false;
    }
  }
  const current = sim.worldMovement,
    previous = configuration.worldMovement;
  for (const key of WORLD_KEYS) {
    if (current[key] !== previous[key]) return false;
  }
  if (Boolean(current.form) !== Boolean(previous.form)) return false;
  for (const key of FORM_KEYS) {
    if (current.form?.[key] !== previous.form?.[key]) return false;
  }
  return true;
}

/** Configuration records are trusted and immutable for their bounded lifetime. */
export function applyMovementSettings(sim, configuration) {
  Object.assign(sim.effectiveSettings, configuration.effectiveSettings);
  Object.assign(sim.worldMovement, configuration.worldMovement);
}
