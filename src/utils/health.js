// server/src/utils/health.js
// Anomaly / health engine. Turns a machine's latest reading into actionable alerts:
//   • sensor faults     — sentinel "no signal" values (disconnected thermocouple)
//   • out-of-range      — values outside a profile's expected/safe band
//   • set↔actual drift  — actual deviates too far from the commanded value
//   • staleness         — "running" but no telemetry (or simply offline)
// Then scores the machine 0–100 and assigns a status. This is the core that turns
// raw telemetry into "what needs attention" — the heart of a monitoring platform.
import { normalizeData, isFaultValue, isNumericValue } from './metrics.js';

const prettyKey = (k) =>
  (k || '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase());

const mk = (key, severity, value, message, category = 'other') => ({ key, severity, value, message, category });
const isCrit = (s) => s === 'fault' || s === 'critical';

// Push a range alert for a numeric value against an expected band.
function rangeAlert(out, rule, key, n, label, unit) {
  if (!rule) return;
  const u = unit && unit !== 'raw' ? unit : '';
  if ((rule.criticalMin != null && n <= rule.criticalMin) || (rule.criticalMax != null && n >= rule.criticalMax)) {
    out.push(mk(key, 'critical', n, `${label}: ${n}${u} is outside the safe range`, 'range'));
  } else if ((rule.min != null && n < rule.min) || (rule.max != null && n > rule.max)) {
    const band = `${rule.min ?? '−∞'}–${rule.max ?? '∞'}${u}`;
    out.push(mk(key, 'warning', n, `${label}: ${n}${u} outside expected ${band}`, 'range'));
  }
}

// Keep the highest-severity alert per signal key.
function dedupe(alerts) {
  const rank = { fault: 4, critical: 3, warning: 2, info: 1 };
  const best = new Map();
  for (const a of alerts) {
    const cur = best.get(a.key);
    if (!cur || (rank[a.severity] || 0) > (rank[cur.severity] || 0)) best.set(a.key, a);
  }
  return [...best.values()];
}

// Evaluate a single reading against its machine profile → alert list.
export function evaluateReading(data, profile) {
  const { named } = normalizeData(data);
  const byKey = Object.fromEntries(named.map((m) => [m.key, m]));
  const alerts = [];

  // 1) Sensor faults (sentinel values) on any named metric.
  for (const m of named) {
    if (isFaultValue(m.value)) alerts.push(mk(m.key, 'fault', m.value, `${prettyKey(m.key)}: sensor fault (no signal)`, 'fault'));
  }

  // 2) Profile key parameters: expected band + set↔actual deviation.
  for (const p of profile?.keyParams || []) {
    const setM = byKey[p.set];
    const actM = p.actual ? byKey[p.actual] : null;
    for (const [m, suffix] of [[setM, ''], [actM, ' (actual)']]) {
      if (m && !isFaultValue(m.value) && isNumericValue(m.value) && p.expected) {
        rangeAlert(alerts, p.expected, m.key, Number(m.value), (p.label || prettyKey(m.key)) + suffix, p.unit);
      }
    }
    if (p.deviation != null && setM && actM &&
        isNumericValue(setM.value) && isNumericValue(actM.value) &&
        !isFaultValue(setM.value) && !isFaultValue(actM.value)) {
      const s = Number(setM.value), a = Number(actM.value);
      if (s !== 0) {
        const dev = Math.abs(a - s) / Math.abs(s) * 100;
        if (dev > p.deviation) alerts.push(mk(p.actual, 'warning', a, `${p.label}: actual ${a} deviates ${dev.toFixed(0)}% from set ${s}`, 'deviation'));
      }
    }
  }

  // 3) Pattern rules (e.g. furnace zone temps H_T*/T_T* share one band).
  for (const pr of profile?.patternRules || []) {
    for (const m of named) {
      if (!pr.test.test(m.key) || isFaultValue(m.value) || !isNumericValue(m.value)) continue;
      rangeAlert(alerts, pr.rule, m.key, Number(m.value), prettyKey(m.key), pr.unit);
    }
  }

  return dedupe(alerts);
}

// live = reported within the offline window; otherwise offline.
export function freshness(lastSeenAt, offlineMs = 120_000) {
  if (!lastSeenAt) return 'offline';
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (!Number.isFinite(age)) return 'offline';
  return age <= offlineMs ? 'live' : 'offline';
}

// Full machine health: reading alerts + staleness, a 0–100 score, and a status.
export function machineHealth(machine, data, profile, { offlineMs = 120_000 } = {}) {
  const alerts = evaluateReading(data, profile);
  const fresh = freshness(machine.lastSeenAt, offlineMs);

  if (fresh === 'offline') {
    if (machine.status === 'running') {
      alerts.unshift(mk('__stale', 'warning', null, 'Marked running but no recent telemetry (stale)', 'stale'));
    } else {
      alerts.unshift(mk('__offline', 'info', null, 'Machine offline — not reporting', 'offline'));
    }
  }

  const critical = alerts.filter((a) => isCrit(a.severity)).length;
  const warning = alerts.filter((a) => a.severity === 'warning').length;
  const score = Math.max(0, Math.min(100, 100 - critical * 25 - warning * 8));
  const status = critical > 0 ? 'critical' : warning > 0 ? 'warning' : fresh === 'offline' ? 'offline' : 'healthy';

  return { alerts, score, status, freshness: fresh, counts: { critical, warning, total: alerts.length } };
}
