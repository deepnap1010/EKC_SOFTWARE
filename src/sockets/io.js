// server/src/sockets/io.js
import { Server } from 'socket.io';
import { verifyToken } from '../utils/jwt.js';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { BOOTSTRAP_SUB } from '../utils/bootstrap.js';

let io = null;

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientOrigin, credentials: true },
  });

  // Authenticate socket handshake with the same JWT
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token'));
      socket.user = verifyToken(token);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    // Resolve this socket's machine scope (null = unrestricted). Restricted users
    // join only per-machine "mdash:<id>" rooms so they never receive live ticks for
    // machines they aren't assigned — the live layer mirrors the REST row-level scope.
    let scope = null;
    try {
      const sub = socket.user?.sub;
      if (sub && sub !== BOOTSTRAP_SUB && !socket.user?.sa) {
        const u = await User.findById(sub).select('assignedMachines isSuperAdmin').lean();
        if (u && !u.isSuperAdmin && Array.isArray(u.assignedMachines) && u.assignedMachines.length) scope = u.assignedMachines;
      }
    } catch { /* fall back to unrestricted live feed; REST still enforces data access */ }
    socket.data.scope = scope;

    const joinDashboard = () => {
      if (!scope) socket.join('dashboard');
      else scope.forEach((id) => socket.join(`mdash:${id}`));
    };
    joinDashboard();

    socket.on('subscribe:machine', (machineId) => {
      if (!scope || scope.includes(machineId)) socket.join(`machine:${machineId}`);
    });
    socket.on('unsubscribe:machine', (machineId) => socket.leave(`machine:${machineId}`));
    socket.on('subscribe:dashboard', joinDashboard);
    socket.on('disconnect', () => {});
  });

  console.log('[socket] initialized');
  return io;
}

export const getIO = () => io;
