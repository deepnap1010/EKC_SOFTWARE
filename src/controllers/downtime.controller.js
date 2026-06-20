// server/src/controllers/downtime.controller.js
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { Machine } from '../models/Machine.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { applyMachineScope, inScope } from '../utils/scope.js';

// GET /downtime — list all events, paginated + filtered
export const listDowntime = asyncHandler(async (req, res) => {
  const { machineId, type, status, plant, from, to, page = 1, limit = 50 } = req.query;
  const q = {};

  if (machineId && machineId !== 'all') q.machineId = machineId;
  if (type && type !== 'all') q.type = type;

  // filter by open/closed
  if (status === 'open') q.endedAt = null;
  else if (status === 'closed') q.endedAt = { $ne: null };

  if (from || to) {
    q.startedAt = {};
    if (from) q.startedAt.$gte = new Date(from);
    if (to) q.startedAt.$lte = new Date(to);
  }

  // filter by plant — telemetry/downtime reference machines by code
  if (plant && plant !== 'all') {
    const codes = await Machine.find({ plant }).select('code').lean();
    q.machineId = { $in: codes.map((m) => m.code) };
  }

  // Row-level scope: restrict to the user's assigned machines.
  if (!applyMachineScope(req.user, q)) return ok(res, [], { total: 0, page: Number(page), limit: Number(limit) });

  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    DowntimeEvent.find(q).sort({ startedAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    DowntimeEvent.countDocuments(q),
  ]);

  return ok(res, items, { total, page: Number(page), limit: Number(limit) });
});

// GET /downtime/summary — aggregate KPIs for the downtime page cards
export const downtimeSummary = asyncHandler(async (req, res) => {
  const { from, to, plant } = req.query;

  const matchStage = {};
  if (from || to) {
    matchStage.startedAt = {};
    if (from) matchStage.startedAt.$gte = new Date(from);
    if (to) matchStage.startedAt.$lte = new Date(to);
  }
  if (plant && plant !== 'all') {
    const codes = await Machine.find({ plant }).select('code').lean();
    matchStage.machineId = { $in: codes.map((m) => m.code) };
  }
  applyMachineScope(req.user, matchStage); // restrict to the user's assigned machines

  const [agg, byMachine] = await Promise.all([
    DowntimeEvent.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalEvents: { $sum: 1 },
          totalMs: { $sum: { $ifNull: ['$durationMs', 0] } },
          openEvents: { $sum: { $cond: [{ $eq: ['$endedAt', null] }, 1, 0] } },
          idleEvents: { $sum: { $cond: [{ $eq: ['$type', 'idle'] }, 1, 0] } },
          stoppedEvents: { $sum: { $cond: [{ $eq: ['$type', 'stopped'] }, 1, 0] } },
        },
      },
    ]),
    DowntimeEvent.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$machineId',
          events: { $sum: 1 },
          totalMs: { $sum: { $ifNull: ['$durationMs', 0] } },
        },
      },
      { $sort: { totalMs: -1 } },
      { $limit: 5 },
    ]),
  ]);

  return ok(res, {
    ...((agg[0]) || { totalEvents: 0, totalMs: 0, openEvents: 0, idleEvents: 0, stoppedEvents: 0 }),
    worstMachines: byMachine,
  });
});

// GET /machines/:code/downtime — downtime for a single machine
export const machineDowntime = asyncHandler(async (req, res) => {
  if (!inScope(req.user, req.params.code)) return fail(res, 403, 'You do not have access to this machine');
  const { page = 1, limit = 20, from, to } = req.query;
  const q = { machineId: req.params.code };
  if (from || to) {
    q.startedAt = {};
    if (from) q.startedAt.$gte = new Date(from);
    if (to) q.startedAt.$lte = new Date(to);
  }
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    DowntimeEvent.find(q).sort({ startedAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    DowntimeEvent.countDocuments(q),
  ]);
  return ok(res, items, { total, page: Number(page), limit: Number(limit) });
});

// PATCH /downtime/:id/reason — operator logs a reason
export const updateReason = asyncHandler(async (req, res) => {
  const { reason, reportedBy } = req.body;
  const event = await DowntimeEvent.findByIdAndUpdate(
    req.params.id,
    { $set: { reason: reason || '', reportedBy: reportedBy || '' } },
    { new: true }
  ).lean();
  if (!event) return fail(res, 404, 'Downtime event not found');
  return ok(res, event);
});
