/**
 * index.js — Chat-Nexus Server
 *
 * FIXES APPLIED:
 *  #1  database.js: PRAGMA foreign_keys + correct seed order (see database.js)
 *  #2  JWT_SECRET no longer regenerates on restart (was logging everyone out on redeploy)
 *  #3  Added helmet + rate limiting for security
 *  #4  Input length validation on all endpoints
 *  #5  message:send verifies user is a member of the channel's server
 *  #6  dm:send verifies receiver exists
 *  #7  File upload restricted to images + common safe types only
 *  #8  onlineUsers tracks socket count per user — disconnect only sets offline when ALL tabs close
 *  #9  server:join socket verifies DB membership before joining room
 *  #10 Added message edit + delete (HTTP + socket events)
 *  #11 JWT extended to 30d with a /api/auth/refresh endpoint
 *  #12 See database.js fix #1
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const db       = require('./database');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || '*', credentials: true }
});

const PORT = process.env.PORT || 3000;

// FIX #2: JWT_SECRET must be stable across restarts — set it in your env vars.
// Falls back to a fixed string for local dev (NOT secure for production).
const JWT_SECRET = process.env.JWT_SECRET || 'nexus-dev-secret-CHANGE-IN-PRODUCTION';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  WARNING: JWT_SECRET not set. Using insecure default. Set JWT_SECRET in your environment variables!');
}

// ── Middleware ────────────────────────────────────────────────
// FIX #3: Security headers
try {
  const helmet = require('helmet');
  app.use(helmet({ contentSecurityPolicy: false })); // CSP off so the frontend loads
} catch {
  console.warn('helmet not installed — run: npm install helmet');
}

app.use(cors({ origin: process.env.CLIENT_URL || '*', credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// FIX #3: Rate limiting
try {
  const rateLimit = require('express-rate-limit');
  app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many attempts, try again in 15 minutes' } }));
} catch {
  console.warn('express-rate-limit not installed — run: npm install express-rate-limit');
}

// FIX #7: File upload — whitelist safe file types only
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain',
  'application/zip',
]);
const ALLOWED_EXTENSIONS = new Set(['.jpg','.jpeg','.png','.gif','.webp','.pdf','.txt','.zip']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase()),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME_TYPES.has(file.mimetype) && ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed. Accepted: images, PDF, TXT, ZIP'));
    }
  },
});

// ── Auth Middleware ───────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Helpers ───────────────────────────────────────────────────
// FIX #4: Reusable input validation
function validate(fields, req, res) {
  for (const [key, { value, max, required }] of Object.entries(fields)) {
    if (required && (!value || !String(value).trim())) {
      res.status(400).json({ error: `${key} is required` });
      return false;
    }
    if (value && max && String(value).length > max) {
      res.status(400).json({ error: `${key} must be ${max} characters or less` });
      return false;
    }
  }
  return true;
}

const safeUser = (u) => ({
  id: u.id, username: u.username, displayName: u.display_name,
  email: u.email, tag: u.tag, color: u.color,
  avatar: u.avatar, bio: u.bio, premium: !!u.premium,
});

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, displayName, email, password } = req.body;

    // FIX #4: Validate all inputs with length limits
    if (!validate({
      username:    { value: username,    required: true, max: 32 },
      displayName: { value: displayName, required: true, max: 50 },
      email:       { value: email,       required: true, max: 254 },
      password:    { value: password,    required: true },
    }, req, res)) return;

    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, dashes, and dots' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email.toLowerCase(), username.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email or username already taken' });

    const hash  = await bcrypt.hash(password, 12);
    const id    = uuidv4();
    const tag   = String(Math.floor(Math.random() * 9000) + 1000);
    const colors = ['#00d4ff','#3b82f6','#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316','#eab308','#22c55e','#14b8a6'];
    const color  = colors[Math.floor(Math.random() * colors.length)];

    db.prepare(`
      INSERT INTO users (id, username, display_name, email, password_hash, tag, color, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, username.toLowerCase(), displayName.trim(), email.toLowerCase(), hash, tag, color);

    // Auto-join the default server
    const defaultServer = db.prepare(`SELECT id FROM servers WHERE invite_code = 'nexus-hq'`).get();
    if (defaultServer) {
      db.prepare(`INSERT OR IGNORE INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'member', datetime('now'))`).run(defaultServer.id, id);
    }

    // FIX #11: 30d token
    const token = jwt.sign({ id, username: username.toLowerCase(), email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: safeUser({ id, username: username.toLowerCase(), display_name: displayName.trim(), email, tag, color, avatar: null, bio: '', premium: 0 }) });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    // Generic message — don't reveal whether the email exists
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    // FIX #11: 30d token
    const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(user) });
});

// FIX #11: Token refresh endpoint — frontend calls this before token expires
app.post('/api/auth/refresh', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// ═══════════════════════════════════════════════════════════════
// USER ROUTES
// ═══════════════════════════════════════════════════════════════
app.put('/api/users/profile', auth, (req, res) => {
  const { displayName, bio } = req.body;
  if (!validate({
    displayName: { value: displayName, max: 50 },
    bio:         { value: bio,         max: 300 },
  }, req, res)) return;
  db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio) WHERE id = ?').run(displayName?.trim() || null, bio?.trim() || null, req.user.id);
  res.json({ success: true });
});

app.post('/api/users/avatar', auth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Only allow images for avatars
  if (!req.file.mimetype.startsWith('image/')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Avatar must be an image' });
  }
  const avatarUrl = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
  res.json({ avatar: avatarUrl });
});

app.get('/api/users/:id', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name, tag, color, avatar, bio, premium FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: { ...user, displayName: user.display_name } });
});

// ═══════════════════════════════════════════════════════════════
// SERVER (GUILD) ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/servers', auth, (req, res) => {
  const { name } = req.body;
  if (!validate({ name: { value: name, required: true, max: 50 } }, req, res)) return;

  const id         = uuidv4();
  const inviteCode = uuidv4().slice(0, 8);
  const colors     = ['#6366f1','#ec4899','#22c55e','#f97316','#3b82f6','#ef4444','#8b5cf6','#14b8a6'];
  const color      = colors[Math.floor(Math.random() * colors.length)];

  const create = db.transaction(() => {
    db.prepare(`INSERT INTO servers (id, name, owner_id, invite_code, color, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(id, name.trim(), req.user.id, inviteCode, color);
    db.prepare(`INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'owner', datetime('now'))`).run(id, req.user.id);
    db.prepare(`INSERT INTO channels (id, server_id, name, type, description, position) VALUES (?, ?, 'general', 'text', 'General discussion', 0)`).run(uuidv4(), id);
    db.prepare(`INSERT INTO channels (id, server_id, name, type, description, position) VALUES (?, ?, 'voice-chat', 'voice', 'Voice channel', 1)`).run(uuidv4(), id);
  });
  create();

  res.status(201).json({ server: { id, name: name.trim(), inviteCode, color } });
});

app.get('/api/servers', auth, (req, res) => {
  const servers = db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members sm ON s.id = sm.server_id
    WHERE sm.user_id = ?
    ORDER BY sm.joined_at
  `).all(req.user.id);
  res.json({ servers });
});

app.get('/api/servers/:id', auth, (req, res) => {
  // Verify caller is a member
  const membership = db.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!membership) return res.status(403).json({ error: 'You are not a member of this server' });

  const server   = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position').all(req.params.id);
  const members  = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.tag, u.color, u.avatar, u.premium, sm.role
    FROM server_members sm JOIN users u ON sm.user_id = u.id
    WHERE sm.server_id = ?
  `).all(req.params.id);
  res.json({ server, channels, members });
});

app.post('/api/servers/join', auth, (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: 'Invite code is required' });

  const server = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(inviteCode.trim());
  if (!server) return res.status(404).json({ error: 'Invalid invite code' });

  const existing = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, req.user.id);
  if (existing) return res.status(409).json({ error: 'You are already a member of this server' });

  db.prepare(`INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'member', datetime('now'))`).run(server.id, req.user.id);
  res.json({ server });
});

app.post('/api/servers/:id/leave', auth, (req, res) => {
  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.owner_id === req.user.id) return res.status(400).json({ error: 'Server owner cannot leave. Transfer ownership or delete the server first.' });
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// CHANNEL ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/servers/:serverId/channels', auth, (req, res) => {
  const { name, type, description } = req.body;
  if (!validate({ name: { value: name, required: true, max: 50 } }, req, res)) return;

  const member = db.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?').get(req.params.serverId, req.user.id);
  if (!member || !['owner', 'mod'].includes(member.role)) return res.status(403).json({ error: 'Only the server owner or mods can create channels' });

  const validTypes = ['text', 'voice'];
  const channelType = validTypes.includes(type) ? type : 'text';
  const id  = uuidv4();
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) as max FROM channels WHERE server_id = ?').get(req.params.serverId);
  db.prepare(`INSERT INTO channels (id, server_id, name, type, description, position) VALUES (?, ?, ?, ?, ?, ?)`).run(id, req.params.serverId, name.trim(), channelType, (description || '').trim().slice(0, 200), pos.max + 1);
  res.status(201).json({ channel: { id, name: name.trim(), type: channelType, description } });
});

// ═══════════════════════════════════════════════════════════════
// MESSAGE ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/api/channels/:channelId/messages', auth, (req, res) => {
  // FIX #5: Verify the user is a member of the server this channel belongs to
  const channel = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const membership = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(channel.server_id, req.user.id);
  if (!membership) return res.status(403).json({ error: 'You are not a member of this server' });

  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before;
  const query  = before
    ? `SELECT m.*, u.username, u.display_name, u.tag, u.color, u.avatar, u.premium FROM messages m JOIN users u ON m.user_id = u.id WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`
    : `SELECT m.*, u.username, u.display_name, u.tag, u.color, u.avatar, u.premium FROM messages m JOIN users u ON m.user_id = u.id WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT ?`;
  const args = before ? [req.params.channelId, before, limit] : [req.params.channelId, limit];
  res.json({ messages: db.prepare(query).all(...args).reverse() });
});

// FIX #10: Edit message via HTTP
app.put('/api/messages/:messageId', auth, (req, res) => {
  const { content } = req.body;
  if (!validate({ content: { value: content, required: true, max: 2000 } }, req, res)) return;

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages' });

  db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(content.trim(), req.params.messageId);
  res.json({ success: true, edited: true });
});

// FIX #10: Delete message via HTTP
app.delete('/api/messages/:messageId', auth, (req, res) => {
  const message = db.prepare('SELECT m.*, c.server_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?').get(req.params.messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const isOwner = message.user_id === req.user.id;
  const serverRole = db.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?').get(message.server_id, req.user.id);
  const isMod   = serverRole && ['owner', 'mod'].includes(serverRole.role);

  if (!isOwner && !isMod) return res.status(403).json({ error: 'You can only delete your own messages' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.messageId);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// DM ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/api/dms', auth, (req, res) => {
  const conversations = db.prepare(`
    SELECT DISTINCT
      CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as other_user_id,
      MAX(created_at) as last_message_at
    FROM direct_messages
    WHERE sender_id = ? OR receiver_id = ?
    GROUP BY other_user_id
    ORDER BY last_message_at DESC
  `).all(req.user.id, req.user.id, req.user.id);

  const result = conversations.map(c => {
    const user    = db.prepare('SELECT id, username, display_name, tag, color, avatar, premium FROM users WHERE id = ?').get(c.other_user_id);
    if (!user) return null;
    const lastMsg = db.prepare('SELECT content, created_at FROM direct_messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY created_at DESC LIMIT 1').get(req.user.id, c.other_user_id, c.other_user_id, req.user.id);
    return { user: { ...user, displayName: user.display_name }, lastMessage: lastMsg };
  }).filter(Boolean);

  res.json({ conversations: result });
});

app.get('/api/dms/:userId/messages', auth, (req, res) => {
  // FIX #6: Verify receiver exists
  const other = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId);
  if (!other) return res.status(404).json({ error: 'User not found' });

  const limit    = Math.min(parseInt(req.query.limit) || 50, 100);
  const messages = db.prepare(`
    SELECT dm.*, u.username, u.display_name, u.tag, u.color, u.avatar, u.premium
    FROM direct_messages dm JOIN users u ON dm.sender_id = u.id
    WHERE (dm.sender_id = ? AND dm.receiver_id = ?) OR (dm.sender_id = ? AND dm.receiver_id = ?)
    ORDER BY dm.created_at DESC LIMIT ?
  `).all(req.user.id, req.params.userId, req.params.userId, req.user.id, limit);
  res.json({ messages: messages.reverse() });
});

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════════════════════
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname, size: req.file.size });
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('File type')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO — REAL-TIME ENGINE
// ═══════════════════════════════════════════════════════════════

// FIX #8: Track socket count per user so multi-tab users don't go "offline" when one tab closes
// Map<userId, Set<socketId>>
const userSockets = new Map();

function addUserSocket(userId, socketId) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socketId);
}
function removeUserSocket(userId, socketId) {
  const sockets = userSockets.get(userId);
  if (!sockets) return 0;
  sockets.delete(socketId);
  if (sockets.size === 0) userSockets.delete(userId);
  return sockets.size;
}
function isUserOnline(userId) {
  return (userSockets.get(userId)?.size || 0) > 0;
}

// Socket auth
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  const userId   = socket.user.id;
  const userData = db.prepare('SELECT id, username, display_name, color, avatar, premium FROM users WHERE id = ?').get(userId);
  if (!userData) return socket.disconnect(true);

  // FIX #8: Register this socket
  addUserSocket(userId, socket.id);
  io.emit('presence:update', { userId, status: 'online' });

  // Send caller current online list
  const onlineList = {};
  userSockets.forEach((_, uid) => { onlineList[uid] = 'online'; });
  socket.emit('presence:list', onlineList);

  // Join all server rooms the user belongs to
  const memberships = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId);
  memberships.forEach(m => socket.join('server:' + m.server_id));

  // ── CHANNEL MESSAGES ───────────────────────────────────────
  socket.on('channel:join', (channelId) => {
    if (typeof channelId !== 'string') return;
    // FIX #5: Verify the user is actually a member of the server
    const ch = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(channelId);
    if (!ch) return;
    const ok = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(ch.server_id, userId);
    if (!ok) return;
    socket.join('channel:' + channelId);
  });

  socket.on('channel:leave', (channelId) => {
    if (typeof channelId === 'string') socket.leave('channel:' + channelId);
  });

  socket.on('message:send', (data) => {
    const { channelId, content, attachment } = data || {};
    if (!channelId || (!content?.trim() && !attachment)) return;

    // FIX #5: Verify membership before saving/broadcasting
    const ch = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(channelId);
    if (!ch) return;
    const ok = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(ch.server_id, userId);
    if (!ok) return;

    // FIX #4: Length cap
    const trimmed = (content || '').trim().slice(0, 2000);
    const id  = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO messages (id, channel_id, user_id, content, attachment_url, attachment_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, channelId, userId, trimmed, attachment?.url || null, attachment?.name || null, now);

    io.to('channel:' + channelId).emit('message:new', {
      id, channel_id: channelId, user_id: userId,
      content: trimmed, attachment_url: attachment?.url || null,
      attachment_name: attachment?.name || null, edited: 0,
      created_at: now,
      username: userData.username, display_name: userData.display_name,
      color: userData.color, avatar: userData.avatar, premium: userData.premium,
    });
  });

  // FIX #10: Edit via socket
  socket.on('message:edit', (data) => {
    const { messageId, content } = data || {};
    if (!messageId || !content?.trim()) return;
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.user_id !== userId) return; // can only edit own messages
    const trimmed = content.trim().slice(0, 2000);
    db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(trimmed, messageId);
    io.to('channel:' + msg.channel_id).emit('message:updated', { messageId, content: trimmed, edited: true });
  });

  // FIX #10: Delete via socket
  socket.on('message:delete', (data) => {
    const { messageId } = data || {};
    if (!messageId) return;
    const msg = db.prepare('SELECT m.*, c.server_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?').get(messageId);
    if (!msg) return;
    const isOwner  = msg.user_id === userId;
    const modRole  = db.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?').get(msg.server_id, userId);
    const isMod    = modRole && ['owner', 'mod'].includes(modRole.role);
    if (!isOwner && !isMod) return;
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    io.to('channel:' + msg.channel_id).emit('message:deleted', { messageId, channelId: msg.channel_id });
  });

  // ── TYPING ─────────────────────────────────────────────────
  socket.on('typing:start', (channelId) => {
    if (typeof channelId === 'string')
      socket.to('channel:' + channelId).emit('typing:update', { userId, username: userData.display_name || userData.username, channelId, typing: true });
  });

  socket.on('typing:stop', (channelId) => {
    if (typeof channelId === 'string')
      socket.to('channel:' + channelId).emit('typing:update', { userId, channelId, typing: false });
  });

  // ── DIRECT MESSAGES ────────────────────────────────────────
  socket.on('dm:send', (data) => {
    const { receiverId, content } = data || {};
    if (!receiverId || !content?.trim()) return;

    // FIX #6: Verify receiver exists
    const receiver = db.prepare('SELECT id FROM users WHERE id = ?').get(receiverId);
    if (!receiver) return;

    const trimmed = content.trim().slice(0, 2000);
    const id  = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO direct_messages (id, sender_id, receiver_id, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, userId, receiverId, trimmed, now);

    const message = {
      id, sender_id: userId, receiver_id: receiverId,
      content: trimmed, created_at: now,
      username: userData.username, display_name: userData.display_name,
      color: userData.color, avatar: userData.avatar, premium: userData.premium,
    };

    socket.emit('dm:new', message);

    // Deliver to all receiver's active sockets (FIX #8: multi-tab)
    const receiverSockets = userSockets.get(receiverId);
    if (receiverSockets) {
      receiverSockets.forEach(sid => io.to(sid).emit('dm:new', message));
    }
  });

  socket.on('dm:typing', (receiverId) => {
    if (typeof receiverId !== 'string') return;
    const receiverSockets = userSockets.get(receiverId);
    if (receiverSockets) {
      receiverSockets.forEach(sid => io.to(sid).emit('dm:typing', { userId, username: userData.display_name || userData.username }));
    }
  });

  // ── SERVER EVENTS ──────────────────────────────────────────
  socket.on('server:join', (serverId) => {
    if (typeof serverId !== 'string') return;
    // FIX #9: Verify DB membership before joining room
    const ok = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
    if (!ok) return;
    socket.join('server:' + serverId);
    io.to('server:' + serverId).emit('server:member_joined', { userId, user: userData });
  });

  // ── DISCONNECT ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    // FIX #8: Only go offline when ALL sockets for this user are gone
    const remaining = removeUserSocket(userId, socket.id);
    if (remaining === 0) {
      io.emit('presence:update', { userId, status: 'offline' });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// CATCH-ALL & START
// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║                                          ║
║          CHAT-NEXUS SERVER               ║
║          Running on port ${PORT}            ║
║                                          ║
║   Open http://localhost:${PORT}             ║
║                                          ║
╚══════════════════════════════════════════╝
  `);
});
