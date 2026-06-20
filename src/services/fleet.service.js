// server/src/services/fleet.service.js
// One pass over the fleet: for every machine, pull its latest telemetry (single
// index-backed $lookup, like the machines list) and run the health engine on it.
// Both the dashboard overview and the alerts feed build on this snapshot, so health
// is computed once and consistently.
import { Machine } from '../models/Machine.js';
import { getProfile } from '../config/machineProfiles.js';
import { normalizeData, rankNamed } from '../utils/metrics.js';
import { machineHealth } from '../utils/health.js';

export async function getFleetSnapshot(scope = null) {
  const docs = await Machine.aggregate([
    ...(scope ? [{ $match: { machineId: { $in: scope } } }] : []),
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
  ]);

  return docs.map((d) => {
    const data = d._latestRow?.data || {};
    const profile = getProfile(d.machineId);
    const { named, inputs, outputs, registers } = normalizeData(data);
    const health = machineHealth(d, data, profile);

    // A few representative current values for an at-a-glance "live values" column.
    const ranked = rankNamed(named);
    const io = [...inputs, ...outputs];
    const keyMetrics = (ranked.length ? ranked.slice(0, 4).map((m) => ({ key: m.key, value: m.value, fault: m.fault }))
      : io.slice(0, 4).map((m) => ({ key: m.key, value: m.on ? 'ON' : 'OFF', fault: false })));

    return {
      machineId:  d.machineId || String(d._id),
      name:       d.machineName || d.machineId || '—',
      type:       d.machineType || null,
      class:      profile?.class || null,
      subtitle:   profile?.subtitle || null,
      status:     d.status || 'offline',
      lastSeenAt: d.lastSeenAt || d.updatedAt || null,
      ts:         d._latestRow?.timestamp || null,
      readings:   d.payloadCount ?? null,
      signals:    named.length + inputs.length + outputs.length,
      namedCount: named.length,
      ioCount:    inputs.length + outputs.length,
      registers:  registers.length,
      faultCount: named.filter((m) => m.fault).length,
      keyMetrics,
      health,
    };
  });
}
