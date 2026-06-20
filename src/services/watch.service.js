// server/src/services/watch.service.js
// The "live" mechanism. Instead of fetching data from any external API or
// simulating it, we open MongoDB Change Streams on the real collections that the
// factory system writes to. When a machine snapshot updates or a new telemetry
// reading lands, we react and push it to subscribed clients over Socket.io.
//
// This is fully READ-ONLY: change streams observe, they never write.
// Atlas (replica set) supports change streams. If they're unavailable for any
// reason, the watchers fail soft — the UI still refreshes via its REST polling.
import { Machine }   from '../models/Machine.js';
import { Telemetry } from '../models/Telemetry.js';
import { getIO }     from '../sockets/io.js';
import { summarizeLatest } from '../utils/metrics.js';

let streams = [];

// Compact projection broadcast to the dashboard room — small payload, many clients.
// Mirrors the real machine document shape (machineId / machineName / lastSeenAt / ...).
function toTick(doc) {
  const id = doc.machineId || String(doc._id);
  return {
    machineId:    id,                       // dashboard keys live ticks by this id
    name:         doc.machineName || id,
    type:         doc.machineType || null,
    status:       doc.status || 'offline',
    lastSeenAt:   doc.lastSeenAt || doc.updatedAt || null,
    readingCount: doc.payloadCount ?? null,
  };
}

function watchMachines() {
  const stream = Machine.watch([], { fullDocument: 'updateLookup' });

  stream.on('change', (change) => {
    if (change.operationType === 'delete') {
      getIO()?.to('dashboard').emit('machine:removed', { id: change.documentKey?._id });
      return;
    }
    const doc = change.fullDocument;
    if (!doc) return;
    const id = doc.machineId || String(doc._id);
    const io = getIO();
    if (!io) return;
    io.to('dashboard').to(`mdash:${id}`).emit('machine:tick', toTick(doc));
    io.to(`machine:${id}`).emit('machine:update', toTick(doc));
  });

  stream.on('error', (err) => {
    console.error('[watch] machines stream error:', err.message);
  });

  return stream;
}

function watchTelemetries() {
  // Only care about new readings being appended.
  const stream = Telemetry.watch([{ $match: { operationType: 'insert' } }], {
    fullDocument: 'updateLookup',
  });

  stream.on('change', (change) => {
    const doc = change.fullDocument;
    if (!doc?.machineId) return;
    const io = getIO();
    if (!io) return;

    // Dashboard / Machines list: a COMPACT classified summary (featured metrics +
    // counts). Bounded payload even for a 3000-register reading → safe to fan out.
    io.to('dashboard').to(`mdash:${doc.machineId}`).emit('telemetry:summary', {
      machineId: doc.machineId,
      ...summarizeLatest(doc.data, doc.timestamp, { cap: 6 }),
    });

    // Per-machine room (detail page): full payload so live current values + history
    // can update in real time for the one machine being viewed.
    io.to(`machine:${doc.machineId}`).emit('telemetry:new', {
      machineId:  doc.machineId,
      timestamp:  doc.timestamp,
      data:       doc.data || {},
      _id:        doc._id,
      receivedAt: doc.receivedAt,
    });
  });

  stream.on('error', (err) => {
    console.error('[watch] telemetries stream error:', err.message);
  });

  return stream;
}

export function startWatchers() {
  try {
    streams = [watchMachines(), watchTelemetries()];
    console.log('[watch] change streams active on machines + telemetries');
  } catch (err) {
    console.warn('[watch] change streams unavailable — UI will rely on REST polling:', err.message);
  }
}

export async function stopWatchers() {
  await Promise.allSettled(streams.map((s) => s.close()));
  streams = [];
}
