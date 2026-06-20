// server/src/config/machineProfiles.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-machine "profiles". The factory's telemetry is schema-agnostic and the same
// physical machine can stream a handful of clean named values OR thousands of raw
// PLC registers. A profile is the human knowledge that turns those raw keys into a
// meaningful, machine-appropriate dashboard:
//   • which keys are the KEY PARAMETERS worth surfacing first (and how to label them)
//   • how to pair a "set" value with its "actual" value to compute achievement %
//   • what business KPIs the machine COULD expose, and which signals each still needs
//
// Profiles are keyed by `machineId` because 4 of 5 real machines report
// machineType = "UNKNOWN" — machineId is the only reliable identity today.
// A machine with no profile still renders via the generic classifier; it just
// won't have curated key-parameter cards.
// ─────────────────────────────────────────────────────────────────────────────

// Machine classes group machines that share a dashboard shape + KPI catalog.
export const MACHINE_CLASS = {
  BOTTOM_MILLING: 'bottom_milling',
  FURNACE: 'furnace',
  QUENCH: 'quench',
};

// ── Profiles ─────────────────────────────────────────────────────────────────
// keyParams: each entry becomes one "key parameter" card on the left dashboard.
//   set          raw data key holding the commanded/target value
//   actual       (optional) raw data key holding the measured value → enables %
//   actualLabel  (optional) short label for the actual register (e.g. "DM130")
//   unit         display unit ("raw" when the PLC sends an unscaled register)
//   group        cards with the same group are visually clustered
// expected: { min, max, criticalMin, criticalMax } → out-of-band raises a warning,
//           crossing a critical bound raises a critical alert.
// deviation: allowed % gap between a set value and its actual before warning.
export const PROFILES = {
  ekc_bottom_milling_01: {
    class: MACHINE_CLASS.BOTTOM_MILLING,
    subtitle: 'Bottom Milling Machine',
    keyParams: [
      { label: 'Depth of Cutting', set: 'depth_of_cutting', actual: 'depth_actual', unit: 'raw', group: 'Depth Control', deviation: 5 },
      { label: 'Servo Slow',       set: 'servo_slow',       actual: 'servo_slow_actual', unit: 'raw', group: 'Servo Control', deviation: 5 },
      { label: 'Fast Servo',       set: 'fast_servo',       actual: 'dm130', actualLabel: 'DM130', unit: 'raw', group: 'Servo Control', deviation: 5 },
    ],
  },

  // Hardening + Tempering furnace. Profile carries zone-temp guard rails so the
  // engine flags disconnected thermocouples (sentinels) and impossible readings
  // (e.g. negative °C). Detail page still renders all 26 zones via the generic grid.
  'ekc-furnace-s7300': {
    class: MACHINE_CLASS.FURNACE,
    subtitle: 'Hardening & Tempering Furnace',
    patternRules: [
      { test: /^[HT]_T\d+$/, unit: '°C', rule: { min: 50, max: 1000, criticalMin: 0 } },
    ],
  },
};

export const getProfile = (machineId) => PROFILES[machineId] || null;
