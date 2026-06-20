// server/src/app.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { notFound, errorHandler } from './middleware/error.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.clientOrigin, credentials: true }));
  app.use(compression());                 // gzip responses -> faster transfer
  app.use(express.json({ limit: '1mb' }));
  if (env.nodeEnv === 'development') app.use(morgan('dev'));

  // Rate limit only the auth + ingest surface
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
  app.use('/api/v1/auth', authLimiter);

  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.use('/api/v1', routes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
