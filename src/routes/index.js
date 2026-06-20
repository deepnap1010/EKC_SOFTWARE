// server/src/routes/index.js
import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import * as auth from '../controllers/auth.controller.js';
import * as machine from '../controllers/machine.controller.js';
import * as dash from '../controllers/dashboard.controller.js';
import * as rbac from '../controllers/rbac.controller.js';
import * as downtime from '../controllers/downtime.controller.js';
import * as reports from '../controllers/reports.controller.js';
import * as alerts from '../controllers/alerts.controller.js';

const r = Router();

// --- Public ---
r.post('/auth/login', auth.login);

// --- Everything below requires a valid session ---
r.use(authenticate);

r.get('/auth/me', auth.me);

// Dashboard
r.get('/dashboard/overview', authorize('dashboard'), dash.overview);
r.get('/dashboard/production', authorize('dashboard'), dash.production);

// Machines (read-only) — identified by code
r.get('/machines', authorize('machines'), machine.listMachines);
r.get('/machines/summary', authorize('machines'), machine.machineSummary);
r.get('/machines/:code', authorize('machines'), machine.getMachine);
r.get('/machines/:code/stats', authorize('machines'), machine.machineStats);
r.get('/machines/:code/series', authorize('history'), machine.machineSeries);
r.get('/machines/:code/history', authorize('history'), machine.machineHistory);
r.get('/machines/:code/downtime', authorize('downtime'), downtime.machineDowntime);

// Downtime
r.get('/downtime', authorize('downtime'), downtime.listDowntime);
r.get('/downtime/summary', authorize('downtime'), downtime.downtimeSummary);
r.patch('/downtime/:id/reason', authorize('downtime', 'update'), downtime.updateReason);

// Reports
r.get('/reports/fleet', authorize('reports'), reports.fleetReport);
r.get('/reports/downtime', authorize('reports'), reports.downtimeReport);
r.get('/reports/reliability', authorize('reports'), reports.reliabilityReport);

// Alerts — fleet-wide, derived live from the anomaly engine
r.get('/alerts', authorize('alerts'), alerts.listAlerts);

// RBAC — roles
r.get('/rbac/meta', authorize('roles'), rbac.rbacMeta);
r.get('/roles', authorize('roles'), rbac.listRoles);
r.post('/roles', authorize('roles', 'create'), rbac.createRole);
r.patch('/roles/:id/permissions', authorize('roles', 'update'), rbac.updateRolePermissions);
r.delete('/roles/:id', authorize('roles', 'delete'), rbac.deleteRole);

// Users / employees
r.get('/users', authorize('employees'), rbac.listUsers);
r.get('/users/orgchart', authorize('orgchart'), rbac.orgChart);
r.post('/users', authorize('employees', 'create'), rbac.createUser);
r.patch('/users/:id', authorize('employees', 'update'), rbac.updateUser);
r.delete('/users/:id', authorize('employees', 'delete'), rbac.deleteUser);

export default r;
