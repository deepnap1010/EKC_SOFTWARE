// server/src/models/DowntimeEvent.js
// Records each idle/stopped span. Closed when machine resumes.
import mongoose from 'mongoose';

const downtimeSchema = new mongoose.Schema(
  {
    machineId: { type: String, required: true, index: true },
    type: { type: String, enum: ['idle', 'stopped'], required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null }, // null = ongoing
    durationMs: { type: Number, default: 0 },
    reason: { type: String, default: '' },  // operator-reported reason
    reportedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

downtimeSchema.index({ machineId: 1, startedAt: -1 });

export const DowntimeEvent = mongoose.model('DowntimeEvent', downtimeSchema, 'downtime_reports');
