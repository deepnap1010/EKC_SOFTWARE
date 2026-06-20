// server/src/utils/bootstrap.js
// First-access bootstrap. While the `users` collection is empty, the app accepts
// the env admin credentials and runs as a synthetic super-admin — WITHOUT writing
// any document. The instant a real user is created, bootstrap mode turns itself off.
import { User } from '../models/User.js';
import { Role, MODULES } from '../models/Role.js';
import { env }  from '../config/env.js';

export const BOOTSTRAP_SUB = '__bootstrap__';

// estimatedDocumentCount is metadata-only (no scan); cache it briefly so we don't
// hit the DB on every authenticated request.
let cache = { val: null, exp: 0 };

export async function isBootstrapMode() {
  const now = Date.now();
  if (cache.val !== null && now < cache.exp) return cache.val;
  const count = await User.estimatedDocumentCount();
  cache = { val: count === 0, exp: now + 30_000 };
  return cache.val;
}

export function invalidateBootstrapCache() {
  cache = { val: null, exp: 0 };
}

export function bootstrapUser() {
  return {
    _id: BOOTSTRAP_SUB,
    name: env.adminName,
    email: env.adminEmail,
    plant: '',
    isSuperAdmin: true,   // bypasses every permission check
    role: null,
    assignedMachines: [],
    active: true,
    bootstrap: true,
  };
}

// Runs once on server start. Guarantees a PERSISTENT super admin exists so the
// platform is never locked out — even after the first real user disables the
// synthetic bootstrap above. Idempotent:
//   • a super admin already exists        → do nothing
//   • a user with the admin email exists  → promote it to super admin
//   • otherwise                           → create it from the ADMIN_* env vars
export async function ensureSuperAdmin() {
  const existing = await User.findOne({ isSuperAdmin: true }).select('email').lean();
  if (existing) return { status: 'present', email: existing.email };

  const byEmail = await User.findOne({ email: env.adminEmail });
  if (byEmail) {
    byEmail.isSuperAdmin = true;
    byEmail.active = true;
    await byEmail.save();
    invalidateBootstrapCache();
    return { status: 'promoted', email: byEmail.email };
  }

  const user = new User({ name: env.adminName, email: env.adminEmail, isSuperAdmin: true, active: true });
  await user.setPassword(env.adminPassword);
  await user.save();
  invalidateBootstrapCache();
  return { status: 'created', email: env.adminEmail };
}

const slugify = (s) => (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Runs on startup. (1) Backfills any role missing a `key` (derives a unique slug
// from its name) — fixes roles that were inserted without one. (2) Seeds a starter
// set of roles only when the collection is completely empty.
export async function ensureRoles() {
  let fixed = 0;
  const missing = await Role.find({ $or: [{ key: { $exists: false } }, { key: null }, { key: '' }] });
  for (const r of missing) {
    let base = slugify(r.name) || 'role';
    let key = base, n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await Role.findOne({ key, _id: { $ne: r._id } })) key = `${base}_${++n}`;
    r.key = key;
    await r.save();
    fixed += 1;
  }

  let seeded = 0;
  if ((await Role.estimatedDocumentCount()) === 0) {
    const all = (acts) => Object.fromEntries(MODULES.map((m) => [m, acts]));
    const defaults = [
      { name: 'Administrator', key: 'administrator', description: 'Full access to every module.', isSystem: true,
        permissions: all(['view', 'create', 'update', 'delete', 'execute', 'approve', 'admin']) },
      { name: 'Manager', key: 'manager', description: 'View everything; manage operations & people.', isSystem: true,
        permissions: { dashboard: ['view'], machines: ['view'], production: ['view'], quality: ['view', 'update', 'approve'], downtime: ['view', 'update'], history: ['view'], reports: ['view'], employees: ['view', 'create', 'update'], roles: ['view'], orgchart: ['view'], alerts: ['view'], settings: ['view'] } },
      { name: 'Supervisor', key: 'supervisor', description: 'Monitor lines; log downtime & quality.', isSystem: true,
        permissions: { dashboard: ['view'], machines: ['view'], production: ['view'], quality: ['view', 'update'], downtime: ['view', 'update'], history: ['view'], reports: ['view'], alerts: ['view'], orgchart: ['view'] } },
      { name: 'Operator', key: 'operator', description: 'View assigned machines; log downtime.', isSystem: true,
        permissions: { dashboard: ['view'], machines: ['view'], downtime: ['view', 'update'], history: ['view'] } },
      { name: 'Viewer', key: 'viewer', description: 'Read-only access to monitoring.', isSystem: true,
        permissions: { dashboard: ['view'], machines: ['view'], reports: ['view'], alerts: ['view'] } },
    ];
    for (const d of defaults) { await Role.create(d); seeded += 1; }
  }

  return { fixed, seeded };
}
