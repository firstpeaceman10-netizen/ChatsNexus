import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { redis } from './services/redis.js';
import { registerSocketHandlers } from './services/socket.js';

// Route imports
import authRoutes from './routes/auth/index.js';
import serverRoutes from './routes/servers/index.js';
import channelRoutes from './routes/channels/index.js';
import messageRoutes from './routes/messages/index.js';
import userRoutes from './routes/users/index.js';
import uploadRoutes from './routes/uploads/index.js';
import billingRoutes from './routes/billing/index.js';

const PORT = process.env.PORT || 3001;

// ─── Fastify setup ─────────────────────────────────────────────────────────
const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  trustProxy: true,
});

// ─── CORS ──────────────────────────────────────────────────────────────────
await app.register(cors, {
  origin: [
    process.env.FRONTEND_URL,
    'https://chatnexus.com',
    'https://www.chatnexus.com',
    ...(process.env.NODE_ENV === 'development' ? ['http://localhost:5173', 'http://localhost:3000'] : []),
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// ─── JWT ───────────────────────────────────────────────────────────────────
await app.register(jwt, {
  secret: process.env.JWT_SECRET,
  sign: { expiresIn: process.env.JWT_EXPIRES_IN || '15m' },
});

// ─── Rate limiting ─────────────────────────────────────────────────────────
await app.register(rateLimit, {
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  redis,
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
  errorResponseBuilder: () => ({
    error: 'Too many requests',
    message: 'Slow down — you\'re being rate limited.',
    statusCode: 429,
  }),
});

// ─── File uploads ──────────────────────────────────────────────────────────
await app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max (plan enforcement happens inside route)
    files: 10,
  },
});

// ─── Auth decorator ────────────────────────────────────────────────────────
app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token.' });
  }
});

// ─── Health check ──────────────────────────────────────────────────────────
app.get('/health', async () => ({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

// ─── API routes ────────────────────────────────────────────────────────────
await app.register(authRoutes,    { prefix: '/api/auth' });
await app.register(serverRoutes,  { prefix: '/api/servers' });
await app.register(channelRoutes, { prefix: '/api/channels' });
await app.register(messageRoutes, { prefix: '/api/messages' });
await app.register(userRoutes,    { prefix: '/api/users' });
await app.register(uploadRoutes,  { prefix: '/api/uploads' });
await app.register(billingRoutes, { prefix: '/api/billing' });

// ─── Global error handler ──────────────────────────────────────────────────
app.setErrorHandler((error, req, reply) => {
  app.log.error(error);

  if (error.validation) {
    return reply.code(400).send({
      error: 'Validation Error',
      message: error.message,
      details: error.validation,
    });
  }

  if (error.statusCode === 429) {
    return reply.code(429).send(error);
  }

  const statusCode = error.statusCode || 500;
  reply.code(statusCode).send({
    error: statusCode === 500 ? 'Internal Server Error' : error.message,
    message: statusCode === 500 ? 'Something went wrong.' : error.message,
  });
});

// ─── WebSocket / Socket.IO ─────────────────────────────────────────────────
const httpServer = createServer(app.server);
const io = new SocketServer(httpServer, {
  cors: {
    origin: [
      process.env.FRONTEND_URL,
      'https://chatnexus.com',
      ...(process.env.NODE_ENV === 'development' ? ['http://localhost:5173'] : []),
    ],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
});

// Make io available to routes
app.decorate('io', io);

// Register all socket event handlers
registerSocketHandlers(io, app);

// ─── Start ─────────────────────────────────────────────────────────────────
try {
  await app.ready();
  await new Promise((resolve, reject) => {
    httpServer.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  console.log(`\n🚀 Nexus Chat backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { io };
