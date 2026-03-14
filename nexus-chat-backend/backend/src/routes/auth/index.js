import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { supabase, query, queryOne } from '../../db/supabase.js';

export default async function authRoutes(app) {

  // ─── Register ──────────────────────────────────────────────────────────
  app.post('/register', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'username', 'password', 'display_name'],
        properties: {
          email:        { type: 'string', format: 'email', maxLength: 254 },
          username:     { type: 'string', minLength: 2, maxLength: 32, pattern: '^[a-zA-Z0-9._-]+$' },
          password:     { type: 'string', minLength: 8, maxLength: 128 },
          display_name: { type: 'string', minLength: 1, maxLength: 32 },
        },
      },
    },
  }, async (req, reply) => {
    const { email, username, password, display_name } = req.body;

    // Check for existing user
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .or(`email.eq.${email.toLowerCase()},username.eq.${username.toLowerCase()}`)
      .limit(1);

    if (existing?.length > 0) {
      return reply.code(409).send({ error: 'Conflict', message: 'Email or username already taken.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        username: username.toLowerCase(),
        display_name,
        password_hash: passwordHash,
      })
      .select('id, email, username, display_name, avatar_url, plan, created_at')
      .single();

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Registration failed' });
    }

    // Create default user settings
    await supabase.from('user_settings').insert({ user_id: user.id });

    const { accessToken, refreshToken } = await generateTokens(app, user);

    return reply.code(201).send({
      user,
      accessToken,
      refreshToken,
    });
  });

  // ─── Login ─────────────────────────────────────────────────────────────
  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('id, email, username, display_name, avatar_url, password_hash, plan, status')
      .eq('email', email.toLowerCase())
      .single();

    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const { accessToken, refreshToken } = await generateTokens(app, user);

    // Update last seen
    await supabase.from('users')
      .update({ last_seen_at: new Date().toISOString(), status: 'online' })
      .eq('id', user.id);

    const { password_hash, ...safeUser } = user;
    return reply.send({ user: safeUser, accessToken, refreshToken });
  });

  // ─── Refresh token ─────────────────────────────────────────────────────
  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return reply.code(400).send({ error: 'Refresh token required' });

    const { data: tokenRecord } = await supabase
      .from('refresh_tokens')
      .select('*, user:users(id, email, username, display_name, plan)')
      .eq('token', refreshToken)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!tokenRecord) {
      return reply.code(401).send({ error: 'Invalid or expired refresh token' });
    }

    // Rotate token
    await supabase.from('refresh_tokens').delete().eq('id', tokenRecord.id);
    const tokens = await generateTokens(app, tokenRecord.user);

    return reply.send(tokens);
  });

  // ─── Logout ────────────────────────────────────────────────────────────
  app.post('/logout', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
      await supabase.from('refresh_tokens').delete().eq('token', refreshToken);
    }
    // Optionally revoke all refresh tokens
    return reply.send({ message: 'Logged out' });
  });

  // ─── Get current user ──────────────────────────────────────────────────
  app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { data: user } = await supabase
      .from('users')
      .select('id, email, username, display_name, avatar_url, banner_url, bio, status, custom_status, plan, created_at, last_seen_at')
      .eq('id', req.user.sub)
      .single();

    if (!user) return reply.code(404).send({ error: 'User not found' });
    return reply.send(user);
  });
}

// ─── Token helpers ─────────────────────────────────────────────────────────
async function generateTokens(app, user) {
  const accessToken = app.jwt.sign({
    sub: user.id,
    email: user.email,
    username: user.username,
    display_name: user.display_name,
    plan: user.plan,
  });

  const rawRefresh = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await supabase.from('refresh_tokens').insert({
    user_id: user.id,
    token: rawRefresh,
    expires_at: expiresAt,
  });

  return { accessToken, refreshToken: rawRefresh };
}
