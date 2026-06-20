// server/src/utils/jwt.js
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const signAccessToken = (payload) =>
  jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiry });

export const signRefreshToken = (payload) =>
  jwt.sign(payload, env.jwtSecret, { expiresIn: env.refreshExpiry });

export const verifyToken = (token) => jwt.verify(token, env.jwtSecret);
