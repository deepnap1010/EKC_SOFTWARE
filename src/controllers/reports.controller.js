// server/src/controllers/reports.controller.js
// Real reporting over the actual collections — no fabricated output/OEE (those
// signals don't exist). Three reports, all row-level scoped to the user's machines:
//   • fleet       — per-machine performance + per-class rollup
//   • downtime    — downtime by machine/type + MTTR
//   • reliability — MTBF / MTTR / availability over a rolling window
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { ok, asyncHandler } from '../utils/http.js';
import { getFleetSnapshot } from '../services/fleet.service.js';
import { machineScope, applyMachineScope } from '../utils/scope.js';

const num = (p) => ({ $ifNull: [p, 0] });

// GET /reports/fleet — per-machine performance + per-class rollup.
export const fleetReport = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user);
  const sm = scope ? { machineId: { $in: scope } } : {};

  const [snapshot, downByMachine] = await Promise.all([
    getFleetSnapshot(scope),
    DowntimeEvent.aggregate([
      { $match: { ...sm } },
      { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') } } },
    ]),
  ]);
  const dt = Object.fromEntries(downByMachine.map((d) => [d._id, d]));

  const machines = snapshot.map((m) => {
    const d = dt[m.machineId] || { events: 0, totalMs: 0 };
    return {
      machineId: m.machineId, name: m.name, type: m.type, class: m.class, status: m.status,
      health: m.health.status, score: m.health.score, readings: m.readings || 0,
      namedCount: m.namedCount || 0, ioCount: m.ioCount || 0, registers: m.registers || 0, faultCount: m.faultCount || 0,
      downtimeMs: d.totalMs, downtimeEvents: d.events,
    };
  });

  const byClass = {};
  for (const m of machines) {
    const c = m.class || 'unclassified';
    const g = byClass[c] || (byClass[c] = { class: c, machines: 0, readings: 0, faults: 0, scoreSum: 0 });
    g.machines += 1; g.readings += m.readings; g.faults += m.faultCount; g.scoreSum += m.score;
  }

  return ok(res, {
    machines,
    byClass: Object.values(byClass)
      .map((g) => ({ class: g.class, machines: g.machines, readings: g.readings, faults: g.faults, avgScore: Math.round(g.scoreSum / g.machines) }))
      .sort((a, b) => b.machines - a.machines),
    totals: {
      machines: machines.length,
      readings: machines.reduce((s, m) => s + m.readings, 0),
      signals: machines.reduce((s, m) => s + m.namedCount + m.ioCount, 0),
      registers: machines.reduce((s, m) => s + m.registers, 0),
      faults: machines.reduce((s, m) => s + m.faultCount, 0),
    },
  });
});

// GET /reports/downtime — downtime by machine + type, with MTTR.
export const downtimeReport = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const match = {};
  if (from || to) {
    match.startedAt = {};
    if (from) match.startedAt.$gte = new Date(from);
    if (to)   match.startedAt.$lte = new Date(to);
  }
  applyMachineScope(req.user, match);

  const [byMachine, byType, totals] = await Promise.all([
    DowntimeEvent.aggregate([
      { $match: match },
      { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') }, open: { $sum: { $cond: [{ $eq: ['$endedAt', null] }, 1, 0] } } } },
      { $sort: { totalMs: -1 } }, { $limit: 50 },
    ]),
    DowntimeEvent.aggregate([
      { $match: match },
      { $group: { _id: '$type', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') } } },
    ]),
    DowntimeEvent.aggregate([
      { $match: match },
      { $group: { _id: null, totalEvents: { $sum: 1 }, totalMs: { $sum: num('$durationMs') }, open: { $sum: { $cond: [{ $eq: ['$endedAt', null] }, 1, 0] } } } },
    ]),
  ]);

  return ok(res, {
    totals: totals[0] || { totalEvents: 0, totalMs: 0, open: 0 },
    byType: byType.map((t) => ({ type: t._id || 'other', events: t.events, totalMs: t.totalMs })).sort((a, b) => b.totalMs - a.totalMs),
    byMachine: byMachine.map((m) => ({ machineId: m._id, events: m.events, totalMs: m.totalMs, open: m.open, mttrMs: m.events ? Math.round(m.totalMs / m.events) : 0 })),
  });
});

// GET /reports/reliability — MTBF / MTTR / availability over a rolling window.
export const reliabilityReport = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user);
  const sm = scope ? { machineId: { $in: scope } } : {};
  const windowDays = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const windowMs = windowDays * 24 * 3600 * 1000;
  const since = new Date(Date.now() - windowMs);

  const agg = await DowntimeEvent.aggregate([
    { $match: { startedAt: { $gte: since }, ...sm } },
    { $group: { _id: '$machineId', events: { $sum: 1 }, totalMs: { $sum: num('$durationMs') } } },
    { $sort: { totalMs: -1 } },
  ]);

  const machines = agg.map((d) => {
    const downtimeMs = Math.min(d.totalMs, windowMs);
    const operatingMs = Math.max(0, windowMs - downtimeMs);
    return {
      machineId: d._id, events: d.events, downtimeMs,
      availability: Math.round((operatingMs / windowMs) * 1000) / 10,   // %
      mttrMs: d.events ? Math.round(downtimeMs / d.events) : 0,         // mean time to repair
      mtbfMs: d.events ? Math.round(operatingMs / d.events) : operatingMs, // mean time between failures
    };
  });

  return ok(res, { windowDays, machines });
});
