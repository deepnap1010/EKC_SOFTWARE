// server/src/models/Plant.js
// READ-ONLY mirror of the (future) `test.plants` collection. Machines reference a
// plant by ObjectId. Until the factory team creates this collection, populate()
// simply yields null and the UI shows "—". No documents are ever created here.
import mongoose from 'mongoose';

const plantSchema = new mongoose.Schema(
  {
    name:     { type: String },
    code:     { type: String },
    location: { type: String },
  },
  { timestamps: true, strict: false, collection: 'plants' }
);

export const Plant = mongoose.model('Plant', plantSchema);
