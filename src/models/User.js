// server/src/models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    passwordHash: { type: String, required: true, select: false },

    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null }, // optional: super admins need none
    isSuperAdmin: { type: Boolean, default: false }, // bypasses all permission checks

    plant: { type: String, default: '' },
    reportsTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // org chart
    assignedMachines: { type: [String], default: [] }, // machineIds for operators

    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

export const User = mongoose.model('User', userSchema);
