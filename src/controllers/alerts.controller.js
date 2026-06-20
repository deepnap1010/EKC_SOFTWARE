// server/src/controllers/alerts.controller.js
// Fleet-wide active alerts, derived live from the latest reading of every machine
// by the anomaly engine (utils/health.js). Real-only: every alert points at a real
// signal on a real machine. Supports severity / machine filtering for the Alerts page.
import { ok, asyncHandler } from '../utils/http.js';
import { getFleetSnapshot } from '../services/fleet.service.js';
import { machineScope } from '../utils/scope.js';

const SEV_RANK = { fault: 4, critical: 3, warning: 2, info: 1 };

export const listAlerts = asyncHandler(async (req, res) => {
  const { severity, machineId } = req.query;
  const snapshot = await getFleetSnapshot(machineScope(req.user));

  let alerts = snapshot.flatMap((m) =>
    m.health.alerts.map((a) => ({
      machineId: m.machineId, machineName: m.name, class: m.class, type: m.type,
      machineStatus: m.status, lastSeenAt: m.lastSeenAt, ts: m.ts,
      key: a.key, severity: a.severity, value: a.value, message: a.message,
    }))
  );

  if (severity && severity !== 'all') {
    alerts = alerts.filter((a) => a.severity === severity || (severity === 'critical' && a.severity === 'fault'));
  }
  if (machineId && machineId !== 'all') alerts = alerts.filter((a) => a.machineId === machineId);
  alerts.sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));

  const summary = {
    total: alerts.length,
    critical: alerts.filter((a) => a.severity === 'fault' || a.severity === 'critical').length,
    warning: alerts.filter((a) => a.severity === 'warning').length,
    info: alerts.filter((a) => a.severity === 'info').length,
    machinesAffected: new Set(alerts.map((a) => a.machineId)).size,
  };

  const machines = snapshot.map((m) => ({
    machineId: m.machineId, name: m.name, class: m.class, status: m.status,
    health: m.health.status, score: m.health.score, alerts: m.health.counts.total, lastSeenAt: m.lastSeenAt,
  }));

  return ok(res, { alerts, summary, machines });
});
