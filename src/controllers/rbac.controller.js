// server/src/controllers/rbac.controller.js
import { Role, MODULES, ACTIONS } from '../models/Role.js';
import { User } from '../models/User.js';
import { ok, created, fail, asyncHandler } from '../utils/http.js';
import { invalidateBootstrapCache } from '../utils/bootstrap.js';

const mapToObj = (m) => (m instanceof Map ? Object.fromEntries(m) : m);

// ---- Roles ----
export const listRoles = asyncHandler(async (req, res) => {
  const roles = await Role.find().sort({ isSystem: -1, name: 1 }).lean();
  return ok(res, roles.map((r) => ({ ...r, permissions: mapToObj(r.permissions) })));
});

export const rbacMeta = asyncHandler(async (req, res) =>
  ok(res, { modules: MODULES, actions: ACTIONS })
);

export const createRole = asyncHandler(async (req, res) => {
  const { name, key, description, permissions } = req.body;
  if (!name || !key) return fail(res, 400, 'name and key required');
  const role = await Role.create({ name, key, description, permissions: permissions || {} });
  return created(res, { ...role.toObject(), permissions: mapToObj(role.permissions) });
});

export const updateRolePermissions = asyncHandler(async (req, res) => {
  const { permissions } = req.body;
  const role = await Role.findByIdAndUpdate(
    req.params.id,
    { $set: { permissions } },
    { new: true }
  ).lean();
  if (!role) return fail(res, 404, 'Role not found');
  return ok(res, { ...role, permissions: mapToObj(role.permissions) });
});

export const deleteRole = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) return fail(res, 404, 'Role not found');
  if (role.isSystem) return fail(res, 403, 'System roles cannot be deleted');
  await role.deleteOne();
  return ok(res, { deleted: true });
});

// ---- Users / Employees ----
export const listUsers = asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 20 } = req.query;
  const q = {};
  if (search) q.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    User.find(q).populate('role', 'name key').sort({ name: 1 }).skip(skip).limit(Number(limit)).lean(),
    User.countDocuments(q),
  ]);
  return ok(res, items.map(stripUser), { total, page: Number(page), limit: Number(limit) });
});

export const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role, plant, reportsTo, assignedMachines, isSuperAdmin } = req.body;
  if (!name || !email || !password) return fail(res, 400, 'name, email and password are required');
  if (!role && !isSuperAdmin) return fail(res, 400, 'Select a role (or mark the user a Super Admin)');
  const user = new User({
    name, email, role: role || null, plant: plant || '',
    reportsTo: reportsTo || null, assignedMachines: assignedMachines || [], isSuperAdmin: !!isSuperAdmin,
  });
  await user.setPassword(password);
  await user.save();
  invalidateBootstrapCache();   // first real user → bootstrap login disables immediately
  const populated = await user.populate('role', 'name key');
  return created(res, stripUser(populated.toObject()));
});

export const updateUser = asyncHandler(async (req, res) => {
  const { password, ...rest } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return fail(res, 404, 'User not found');
  Object.assign(user, rest);
  if (password) await user.setPassword(password);
  await user.save();
  const populated = await user.populate('role', 'name key');
  return ok(res, stripUser(populated.toObject()));
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  if (!user) return fail(res, 404, 'User not found');
  return ok(res, { deactivated: true });
});

// GET /users/orgchart — the reporting tree
export const orgChart = asyncHandler(async (req, res) => {
  const users = await User.find({ active: true }).populate('role', 'name key').lean();
  return ok(res, users.map(stripUser));
});

function stripUser(u) {
  return {
    id: u._id,
    name: u.name,
    email: u.email,
    plant: u.plant,
    isSuperAdmin: u.isSuperAdmin,
    role: u.role ? { id: u.role._id, name: u.role.name, key: u.role.key } : null,
    reportsTo: u.reportsTo || null,
    assignedMachines: u.assignedMachines || [],
    active: u.active,
  };
}
