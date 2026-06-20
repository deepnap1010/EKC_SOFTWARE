// server/src/middleware/error.js
import { fail } from '../utils/http.js';
import { env } from '../config/env.js';

export function notFound(req, res) {
  return fail(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
}

export function errorHandler(err, req, res, _next) {
  console.error('[error]', err.message);

  if (err.name === 'ZodError') {
    return fail(res, 422, 'Validation failed', err.errors);
  }
  if (err.name === 'ValidationError') {
    return fail(res, 422, 'Validation failed', Object.values(err.errors).map((e) => e.message));
  }
  if (err.code === 11000) {
    return fail(res, 409, 'Duplicate entry', err.keyValue);
  }

  const status = err.status || 500;
  return fail(res, status, err.message || 'Internal server error',
    env.nodeEnv === 'development' ? err.stack : undefined);
}
