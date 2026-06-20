// server/src/models/Role.js
// Dynamic RBAC. Each role holds a permission matrix: module -> set of actions.
// Matches the "Roles & Permissions" grid in the reference UI.
import mongoose from 'mongoose';

// The canonical action set per module
export const ACTIONS = ['view', 'create', 'update', 'delete', 'execute', 'approve', 'admin'];

// The modules the system exposes (single source of truth for the grid)
export const MODULES = [
  'dashboard',
  'machines',
  'production',
  'quality',
  'downtime',
  'history',
  'reports',
  'employees',
  'roles',
  'orgchart',
  'alerts',
  'settings',
];

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },          // "Production Supervisor"
    key: { type: String, required: true, unique: true }, // "supervisor"
    description: { type: String, default: '' },
    isSystem: { type: Boolean, default: false },     // system roles can't be deleted

    // { dashboard: ['view'], machines: ['view','update'], ... }
    permissions: {
      type: Map,
      of: [String],
      default: {},
    },
  },
  { timestamps: true }
);

export const Role = mongoose.model('Role', roleSchema);
