// server/src/utils/scope.js
// Row-level machine visibility. A user's `assignedMachines` scopes which machines
// they can see. Rule:
//   • Super admins                 → no restriction (see everything)
//   • non-empty assignedMachines   → restricted to exactly those machineIds
//   • empty assignedMachines       → no restriction (see everything)
// Enforced on the backend so it can't be bypassed by calling the API directly.

// Returns null when unrestricted, or an array of allowed machineIds.
export function machineScope(user) {
  if (!user || user.isSuperAdmin) return null;
  const list = Array.isArray(user.assignedMachines) ? user.assignedMachines : [];
  return list.length ? list : null;
}

// Is a single machine visible to this user?
export function inScope(user, machineId) {
  const scope = machineScope(user);
  return !scope || scope.includes(machineId);
}

// A Mongo $match fragment for the current scope ({} when unrestricted).
export function scopeMatch(user) {
  const scope = machineScope(user);
  return scope ? { machineId: { $in: scope } } : {};
}

// Narrow an existing query object's `machineId` by the user's scope (mutates q).
// Returns false when the caller already requested a machine outside scope — the
// caller should then return an empty result.
export function applyMachineScope(user, q) {
  const scope = machineScope(user);
  if (!scope) return true;
  if (typeof q.machineId === 'string') return scope.includes(q.machineId);
  if (q.machineId && q.machineId.$in) { q.machineId.$in = q.machineId.$in.filter((id) => scope.includes(id)); return true; }
  q.machineId = { $in: scope };
  return true;
}
