// server/src/models/Machine.js
// READ-ONLY mirror of the real `test.machines` collection.
// The factory's own ingestion system owns these documents — we never write them.
// `strict: false` lets any extra fields the factory adds flow through untouched.
//
// IMPORTANT: the real collection keys identity off `machineId` (e.g. "ekc-furnace-s7300"),
// NOT a `code`/`name`/`type` triple. The fields below mirror what the ingestion writes:
//   machineId    — business key, also the telemetry foreign key (telemetry.machineId)
//   machineName  — human label
//   machineType  — e.g. "furnace01", "UNKNOWN"
//   status       — "running" | "idle" | "stopped" | "offline" | ...
//   lastSeenAt   — timestamp of the most recent payload (freshness)
//   payloadCount — cumulative readings ingested for this machine
import mongoose from 'mongoose';

const machineSchema = new mongoose.Schema(
  {
    machineId:   { type: String, index: true },   // canonical id ↔ telemetry.machineId
    machineName: { type: String },
    machineType: { type: String, index: true },
    status:      { type: String, index: true },

    isActive:    { type: Boolean, default: true },
    lastSeenAt:  { type: Date },                   // most recent reading time
    payloadCount:{ type: Number, default: 0 },     // cumulative readings ingested
    registeredAt:{ type: Date },
  },
  { timestamps: true, strict: false, collection: 'machines' }
);

// Common dashboard / list-sort access patterns.
machineSchema.index({ status: 1, machineName: 1 });
machineSchema.index({ machineType: 1, status: 1 });
machineSchema.index({ lastSeenAt: -1 });
machineSchema.index({ payloadCount: -1 });

export const Machine = mongoose.model('Machine', machineSchema);
