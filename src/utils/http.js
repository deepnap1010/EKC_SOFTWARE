// server/src/utils/http.js
// Consistent envelope so the frontend always parses the same shape.
export const ok = (res, data, meta) =>
  res.json({ success: true, data, ...(meta ? { meta } : {}) });

export const created = (res, data) =>
  res.status(201).json({ success: true, data });

export const fail = (res, status, message, details) =>
  res.status(status).json({ success: false, error: { message, details } });

// Wrap async controllers so we never forget try/catch
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
