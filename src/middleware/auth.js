// server/src/middleware/auth.js
import { verifyToken } from '../utils/jwt.js';
import { fail } from '../utils/http.js';
import { User } from '../models/User.js';
import { BOOTSTRAP_SUB, isBootstrapMode, bootstrapUser } from '../utils/bootstrap.js';

// Verifies the bearer token, loads user + role into req.user
export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 401, 'Authentication required');

    const decoded = verifyToken(token);

    // Bootstrap session — valid only while no real users exist.
    if (decoded.sub === BOOTSTRAP_SUB) {
      if (await isBootstrapMode()) { req.user = bootstrapUser(); return next(); }
      return fail(res, 401, 'Bootstrap session expired — please sign in');
    }

    const user = await User.findById(decoded.sub).populate('role').lean();
    if (!user || !user.active) return fail(res, 401, 'Invalid or inactive account');

    req.user = user;
    next();
  } catch (err) {
    return fail(res, 401, 'Session expired or invalid token');
  }
}

// Guards a route by module + action. Super admin bypasses everything.
export function authorize(module, action = 'view') {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return fail(res, 401, 'Authentication required');
    if (user.isSuperAdmin) return next();

    const perms = user.role?.permissions || {};
    const allowed = perms instanceof Map ? (perms.get(module) || []) : (perms[module] || []);
    if (allowed.includes(action) || allowed.includes('admin')) return next();

    return fail(res, 403, `Not allowed to ${action} ${module}`);
  };
}
