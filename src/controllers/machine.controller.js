// server/src/controllers/machine.controller.js
// READ-ONLY access to the real `machines` + `telemetries` collections.
//
// A machine is identified by its `machineId` (e.g. "ekc-furnace-s7300"); telemetry
// rows reference it via the same `machineId`. The controller normalizes the raw
// factory documents into a stable, capped contract the frontend can rely on — so the
// UI never has to know the underlying field names and never receives 3000 metric keys.
import mongoose from 'mongoose';
import { Machine }   from '../models/Machine.js';
import { Telemetry } from '../models/Telemetry.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { rankNamed, summarizeLatest, computeStats, normalizeData, isNumericValue, isFaultValue } from '../utils/metrics.js';
import { getProfile } from '../config/machineProfiles.js';
import { machineScope, inScope } from '../utils/scope.js';

// Map a raw machine document to the clean shape the client consumes. Optional fields
// (oee/totalOutput) are passed through only when the factory actually provides them,
// so the UI can light up later without fabricating zeros today.
function normalizeMachine(doc) {
  return {
    id:           doc.machineId || String(doc._id),
    machineId:    doc.machineId || null,
    name:         doc.machineName || doc.machineId || '—',
    type:         doc.machineType || null,
    status:       doc.status || 'offline',
    isActive:     doc.isActive !== false,
    lastSeenAt:   doc.lastSeenAt || doc.updatedAt || null,
    registeredAt: doc.registeredAt || doc.createdAt || null,
    readingCount: doc.payloadCount ?? null,
    oee:          typeof doc.oee === 'number' ? doc.oee : null,
    totalOutput:  typeof doc.totalOutput === 'number' ? doc.totalOutput : null,
  };
}

// GET /machines — paginated, filterable list.
// Each machine is enriched with a compact summary of its latest telemetry payload in
// ONE aggregation: a $lookup sub-pipeline reads exactly 1 telemetry row per machine
// off the { machineId, timestamp } index. Heavy metric classification + capping then
// happens in Node so the client payload stays tiny regardless of payload width.
export const listMachines = asyncHandler(async (req, res) => {
  const { search, status, type, sort = 'name', page = 1, limit = 60 } = req.query;
  const match = {};
  if (status && status !== 'all') match.status = status;
  if (type   && type   !== 'all') match.machineType = type;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    match.$or = [{ machineId: rx }, { machineName: rx }, { machineType: rx }];
  }
  // Row-level scope: restrict to the user's assigned machines (unless super admin).
  const scope = machineScope(req.user);
  if (scope) match.machineId = { $in: scope };

  const sortMap = {
    name:    { machineName: 1, machineId: 1 },
    status:  { status: 1, machineName: 1 },
    recent:  { lastSeenAt: -1 },
    readings:{ payloadCount: -1 },
  };
  const lim  = Math.min(Number(limit) || 60, 200);
  const skip = (Math.max(1, Number(page)) - 1) * lim;

  const [docs, total] = await Promise.all([
    Machine.aggregate([
      { $match: match },
      { $sort: sortMap[sort] || sortMap.name },
      { $skip: skip },
      { $limit: lim },
      {
        $lookup: {
          from: 'telemetries',
          let: { ref: '$machineId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$machineId', '$$ref'] } } },
            { $sort: { timestamp: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, data: 1, timestamp: 1 } },
          ],
          as: '_latest',
        },
      },
      { $addFields: { _latestRow: { $first: '$_latest' } } },
      { $project: { _latest: 0 } },
    ]),
    Machine.countDocuments(match),
  ]);

  const items = docs.map((doc) => ({
    ...normalizeMachine(doc),
    latest: summarizeLatest(doc._latestRow?.data, doc._latestRow?.timestamp, { cap: 6 }),
  }));

  return ok(res, items, { total, page: Number(page), limit: lim });
});

// GET /machines/summary — status counts for the cards (single aggregation)
export const machineSummary = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user);
  const agg = await Machine.aggregate([
    ...(scope ? [{ $match: { machineId: { $in: scope } } }] : []),
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const summary = { total: 0, running: 0, idle: 0, stopped: 0, offline: 0 };
  agg.forEach((r) => {
    const key = r._id || 'offline';
    summary[key] = (summary[key] || 0) + r.count;
    summary.total += r.count;
  });
  return ok(res, summary);
});

// Resolve a machine by machineId (preferred) or _id fallback.
async function findMachine(idOrCode) {
  let m = await Machine.findOne({ machineId: idOrCode }).lean();
  if (!m && mongoose.isValidObjectId(idOrCode)) m = await Machine.findById(idOrCode).lean();
  return m;
}

// GET /machines/:code — full, profile-enriched detail for one machine.
// Returns a stable contract the redesigned dashboard renders directly:
//   keyParams   — curated set/actual cards (from the machine profile), or null
//   metrics     — full ranked named-metric set
//   inputs/outputs — digital I/O (for I/O-heavy machines like BOTTOMMILLING2)
//   registers   — capped raw PLC register list (progressive disclosure on client)
//   expectations— real-only KPI panel: what we can derive + what each gap needs
export const getMachine = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');

  const ref = m.machineId || String(m._id);
  if (!inScope(req.user, ref)) return fail(res, 403, 'You do not have access to this machine');

  const [telemetryCount, latestTelemetry] = await Promise.all([
    Telemetry.countDocuments({ machineId: ref }),
    Telemetry.findOne({ machineId: ref }).sort({ timestamp: -1 }).lean(),
  ]);

  const data = latestTelemetry?.data || {};
  const { named, inputs, outputs, registers } = normalizeData(data);
  const rankedNamed = rankNamed(named);
  const profile = getProfile(ref);
  const faultCount = named.filter((x) => x.fault).length;

  return ok(res, {
    ...normalizeMachine(m),
    class:          profile?.class || null,
    subtitle:       profile?.subtitle || null,
    telemetryCount: telemetryCount || m.payloadCount || 0,
    latest: {
      ts:            latestTelemetry?.timestamp || null,
      receivedAt:    latestTelemetry?.receivedAt || null,
      hasData:       named.length > 0 || registers.length > 0 || inputs.length + outputs.length > 0,
      namedCount:    named.length,
      registerCount: registers.length,
      ioCount:       inputs.length + outputs.length,
      faultCount,
    },
    keyParams: buildKeyParams(profile, data),
    // Full named-metric set (ranked) for the detail stat cards.
    metrics: rankedNamed.map((x) => ({ key: x.key, value: x.value, numeric: x.numeric, fault: x.fault })),
    // Digital I/O (empty for machines that don't report it).
    inputs:  inputs.map((x) => ({ key: x.key, on: x.on, value: x.value })),
    outputs: outputs.map((x) => ({ key: x.key, on: x.on, value: x.value })),
    // Raw registers (key+value preserved from wherever they were nested), capped.
    registers: registers.slice(0, 2000).map((r) => ({ key: r.key, value: r.value })),
    registerCount: registers.length,
    ioCount: inputs.length + outputs.length,
  });
});

// GET /machines/:code/stats — per-metric min/max/avg/last + sparkline over a window.
// Computed server-side over the index-backed telemetry slice; faults are excluded
// from the aggregates but counted. Scales because the window and metric count are
// both bounded regardless of how wide the machine's payload is.
export const machineStats = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');
  const ref = m.machineId || String(m._id);
  if (!inScope(req.user, ref)) return fail(res, 403, 'You do not have access to this machine');

  const window = Math.min(Number(req.query.window) || 120, 500);
  const readings = await Telemetry.find({ machineId: ref })
    .sort({ timestamp: -1 })
    .limit(window)
    .select({ timestamp: 1, data: 1, _id: 0 })
    .lean();

  const { metrics, metricCount } = computeStats(readings, { sparkPoints: 32, maxMetrics: 64 });
  return ok(res, { window: readings.length, metricCount, metrics });
});

// GET /machines/:code/series — time-bucketed OHLC candles for ONE metric, for the
// stock-style chart. interval ∈ 5m|15m|30m|1h. Buckets the recent reading window by
// the interval and computes open/high/low/close/avg per bucket (faults excluded).
const SERIES_INTERVALS = { '30s': 30000, '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000 };
export const machineSeries = asyncHandler(async (req, res) => {
  const m = await findMachine(req.params.code);
  if (!m) return fail(res, 404, 'Machine not found');
  const ref = m.machineId || String(m._id);
  if (!inScope(req.user, ref)) return fail(res, 403, 'You do not have access to this machine');

  const interval = SERIES_INTERVALS[req.query.interval] ? req.query.interval : '5m';
  const intervalMs = SERIES_INTERVALS[interval];

  // Pull a bounded recent window (newest first), then work oldest→newest.
  const rows = await Telemetry.find({ machineId: ref })
    .sort({ timestamp: -1 }).limit(3000).select({ timestamp: 1, data: 1, _id: 0 }).lean();
  rows.reverse();

  // Normalize each reading's named metrics once; discover numeric keys + their spread.
  const normalized = rows.map((r) => ({ t: new Date(r.timestamp).getTime(), named: normalizeData(r.data).named }));
  const spread = {}; // key -> {min,max,count}
  for (const r of normalized) {
    for (const mm of r.named) {
      if (!mm.numeric || mm.fault) continue;
      const v = Number(mm.value);
      const s = spread[mm.key] || (spread[mm.key] = { min: v, max: v, count: 0 });
      s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.count += 1;
    }
  }
  const availableMetrics = Object.keys(spread).sort((a, b) => a.localeCompare(b));

  // Chosen metric, or default to the one with the widest range (most "interesting").
  let metric = req.query.metric && spread[req.query.metric] ? req.query.metric : null;
  if (!metric) {
    metric = availableMetrics.slice().sort((a, b) => (spread[b].max - spread[b].min) - (spread[a].max - spread[a].min))[0] || null;
  }

  // Bucket the chosen metric into OHLC candles.
  const buckets = new Map();
  if (metric) {
    for (const r of normalized) {
      const entry = r.named.find((x) => x.key === metric);
      if (!entry || !entry.numeric || entry.fault) continue;
      const v = Number(entry.value);
      const bt = Math.floor(r.t / intervalMs) * intervalMs;
      const b = buckets.get(bt);
      if (!b) buckets.set(bt, { t: bt, open: v, high: v, low: v, close: v, sum: v, count: 1 });
      else { b.high = Math.max(b.high, v); b.low = Math.min(b.low, v); b.close = v; b.sum += v; b.count += 1; }
    }
  }
  let series = [...buckets.values()].sort((a, b) => a.t - b.t).map((b) => ({
    t: b.t, open: b.open, high: b.high, low: b.low, close: b.close,
    avg: Math.round((b.sum / b.count) * 100) / 100, count: b.count,
  }));
  if (series.length > 120) series = series.slice(-120); // keep the chart readable

  return ok(res, { metric, interval, availableMetrics, series });
});

// GET /machines/:code/history — telemetry readings, range + paginated (20/page).
// Backed by the { machineId, timestamp } compound index → fast at scale.
export const machineHistory = asyncHandler(async (req, res) => {
  if (!inScope(req.user, req.params.code)) return fail(res, 403, 'You do not have access to this machine');
  const { from, to, page = 1, limit = 20 } = req.query;
  const lim  = Math.min(Number(limit) || 20, 200);
  const skip = (Math.max(1, Number(page)) - 1) * lim;

  const q = { machineId: req.params.code };
  if (from || to) {
    q.timestamp = {};
    if (from) q.timestamp.$gte = new Date(from);
    if (to)   q.timestamp.$lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    Telemetry.find(q).sort({ timestamp: -1 }).skip(skip).limit(lim).lean(),
    Telemetry.countDocuments(q),
  ]);

  return ok(res, items, { total, page: Number(page), limit: lim });
});

// --- helpers ---
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build curated "key parameter" cards from a profile: pair each set value with its
// actual and compute achievement %. Returns null when the machine has no profile.
function buildKeyParams(profile, data) {
  if (!profile?.keyParams?.length) return null;
  const read = (k) => (k == null ? undefined : data[k]);
  return profile.keyParams.map((p) => {
    const setV = read(p.set);
    const actV = p.actual ? read(p.actual) : undefined;
    const sNum = isNumericValue(setV) ? Number(setV) : null;
    const aNum = isNumericValue(actV) ? Number(actV) : null;
    const pct  = (sNum != null && aNum != null && sNum !== 0)
      ? Math.round((aNum / sNum) * 1000) / 10
      : null;
    return {
      label: p.label, group: p.group || null, unit: p.unit || null,
      set:    { key: p.set, value: setV ?? null, fault: isFaultValue(setV) },
      actual: p.actual ? { key: p.actual, label: p.actualLabel || null, value: actV ?? null, fault: isFaultValue(actV) } : null,
      pct,
    };
  });
}

