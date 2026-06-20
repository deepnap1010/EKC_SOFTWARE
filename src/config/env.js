// server/src/config/env.js
import dotenv from 'dotenv';
dotenv.config();

const required = (key, fallback) => {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    console.warn(`[env] Missing ${key}, app may misbehave`);
  }
  return val;
};

export const env = {
  nodeEnv:  process.env.NODE_ENV || 'development',
  port:     parseInt(process.env.PORT || '5000', 10),

  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/test'),
  // Explicit target database. The real data lives in `test` on the EKC cluster.
  // Overrides any db path in the URI so we never accidentally hit the wrong DB.
  dbName:   process.env.DB_NAME || 'test',

  jwtSecret:    required('JWT_SECRET', 'dev-only-change-me'),
  jwtExpiry:    process.env.JWT_EXPIRY    || '12h',
  refreshExpiry: process.env.REFRESH_EXPIRY || '7d',

  clientOrigin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(','),

  // First-access bootstrap admin. Used ONLY while the `users` collection is empty;
  // it issues a session without writing any document. As soon as you create real
  // users, this bootstrap auto-disables. See auth.controller.js / middleware/auth.js.
  adminName:     process.env.ADMIN_NAME     || 'Super Admin',
  adminEmail:    (process.env.ADMIN_EMAIL   || 'admin@ekc.in').toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
};
