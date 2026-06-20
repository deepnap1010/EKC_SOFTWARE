// server/src/models/Telemetry.js
// READ-ONLY mirror of the real `test.telemetries` collection (a plain collection,
// NOT time-series). One document per reading. We only ever read + watch it.
//   machineId  -> matches Machine.code
//   timestamp  -> when the reading was taken
//   data       -> schema-agnostic metric map (varies by machine type)
import mongoose from 'mongoose';

const telemetrySchema = new mongoose.Schema(
  {
    machineId:   { type: String, index: true },
    machineName: { type: String },
    machineType: { type: String },
    timestamp:   { type: Date },
    receivedAt:  { type: Date },
    data:        { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { strict: false, collection: 'telemetries', versionKey: false }
);

// The history query is always: this machine, newest first → make it index-covered & fast at scale.
telemetrySchema.index({ machineId: 1, timestamp: -1 });

export const Telemetry = mongoose.model('Telemetry', telemetrySchema);
