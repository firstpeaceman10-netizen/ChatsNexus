import Redis from 'ioredis';

let redisClient;

function getRedis() {
  if (!redisClient) {
    if (!process.env.REDIS_URL) {
      console.warn('⚠️  No REDIS_URL set — using in-memory fallback (dev only)');
      return createMemoryFallback();
    }
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    });
    redisClient.on('error', (err) => console.error('Redis error:', err.message));
    redisClient.on('connect', () => console.log('✅ Redis connected'));
  }
  return redisClient;
}

// Simple in-memory fallback for local dev without Redis
function createMemoryFallback() {
  const store = new Map();
  const expiries = new Map();
  return {
    async get(key) { return expiries.get(key) < Date.now() ? null : store.get(key) ?? null; },
    async set(key, val, ...args) {
      store.set(key, val);
      const exIdx = args.indexOf('EX');
      if (exIdx !== -1) expiries.set(key, Date.now() + args[exIdx + 1] * 1000);
      return 'OK';
    },
    async del(...keys) { keys.forEach(k => store.delete(k)); return keys.length; },
    async exists(key) { return store.has(key) ? 1 : 0; },
    async incr(key) { const v = (parseInt(store.get(key)) || 0) + 1; store.set(key, String(v)); return v; },
    async expire(key, secs) { expiries.set(key, Date.now() + secs * 1000); return 1; },
    async smembers(key) { return JSON.parse(store.get(key) || '[]'); },
    async sadd(key, ...members) { const s = new Set(JSON.parse(store.get(key) || '[]')); members.forEach(m => s.add(m)); store.set(key, JSON.stringify([...s])); return 1; },
    async srem(key, ...members) { const s = new Set(JSON.parse(store.get(key) || '[]')); members.forEach(m => s.delete(m)); store.set(key, JSON.stringify([...s])); return 1; },
  };
}

export const redis = getRedis();

// ─── Presence helpers ──────────────────────────────────────────────────────

export const PRESENCE_TTL = 30; // seconds

export async function setUserOnline(userId, status = 'online') {
  await redis.set(`presence:${userId}`, status, 'EX', PRESENCE_TTL * 3);
}

export async function setUserOffline(userId) {
  await redis.del(`presence:${userId}`);
}

export async function getUserPresence(userId) {
  return await redis.get(`presence:${userId}`) || 'offline';
}

export async function getMultiPresence(userIds) {
  const results = {};
  await Promise.all(
    userIds.map(async (id) => {
      results[id] = await getUserPresence(id);
    })
  );
  return results;
}

// ─── Typing indicator helpers ─────────────────────────────────────────────

export async function setTyping(channelId, userId, displayName) {
  const key = `typing:${channelId}`;
  await redis.set(`${key}:${userId}`, displayName, 'EX', 5);
}

export async function clearTyping(channelId, userId) {
  await redis.del(`typing:${channelId}:${userId}`);
}

// ─── Rate limit helpers ────────────────────────────────────────────────────

export async function checkMessageRateLimit(userId, plan) {
  const key = `msg_rate:${userId}`;
  const limit = plan === 'pro' ? 60 : 20; // messages per minute
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count <= limit;
}
