// server/src/index.js
import http from 'http';
import { createApp } from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { env } from './config/env.js';
import { initSocket } from './sockets/io.js';
import { startWatchers, stopWatchers } from './services/watch.service.js';
import { ensureSuperAdmin, ensureRoles } from './utils/bootstrap.js';

async function start() {
  await connectDB();

  // Provision roles (backfill keys / seed defaults) + a persistent super admin so
  // the RBAC system is always in a usable state and the platform is never locked out.
  try {
    const r = await ensureRoles();
    if (r.fixed || r.seeded) console.log(`[seed] roles — backfilled ${r.fixed} key(s), seeded ${r.seeded}`);
    const sa = await ensureSuperAdmin();
    console.log(`[seed] super admin ${sa.status}: ${sa.email}`);
  } catch (err) {
    console.warn('[seed] provisioning failed:', err.message);
  }

  const app    = createApp();
  const server = http.createServer(app);
  initSocket(server);

  // Live updates come straight from MongoDB change streams on the real collections.
  // No ingest, no simulation, no DB polling — we react to what the factory writes.
  startWatchers();

  server.listen(env.port, () => {
    console.log(`[server] EKC SmartFactory API on :${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async () => {
    await stopWatchers();
    server.close();
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
