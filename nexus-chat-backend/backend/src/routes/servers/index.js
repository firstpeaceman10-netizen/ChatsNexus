import { supabase } from '../../db/supabase.js';

const FREE_SERVER_LIMIT = 5;

export default async function serverRoutes(app) {

  // ─── Get all servers for current user ──────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    const { data: memberships } = await supabase
      .from('server_members')
      .select(`
        role,
        server:servers(
          id, name, description, icon_url, banner_url,
          owner_id, invite_code, member_count, created_at
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { foreignTable: 'servers', ascending: true });

    return reply.send(memberships?.map(m => ({ ...m.server, role: m.role })) || []);
  });

  // ─── Get single server ─────────────────────────────────────────────────
  app.get('/:serverId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params;
    const userId = req.user.sub;

    const isMember = await checkMembership(userId, serverId);
    if (!isMember) return reply.code(403).send({ error: 'Not a member of this server' });

    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', serverId)
      .single();

    if (!server) return reply.code(404).send({ error: 'Server not found' });

    // Get channels
    const { data: channels } = await supabase
      .from('channels')
      .select('id, name, description, type, position, category, slowmode_seconds')
      .eq('server_id', serverId)
      .order('position', { ascending: true });

    // Get members with presence
    const { data: members } = await supabase
      .from('server_members')
      .select(`
        role, nickname, joined_at,
        user:users(id, username, display_name, avatar_url, status)
      `)
      .eq('server_id', serverId);

    return reply.send({ ...server, channels, members });
  });

  // ─── Create server ─────────────────────────────────────────────────────
  app.post('/', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:        { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          is_public:   { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const userId = req.user.sub;
    const { name, description = '', is_public = false } = req.body;

    // Enforce free plan server limit
    if (req.user.plan === 'free') {
      const { count } = await supabase
        .from('server_members')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      if (count >= FREE_SERVER_LIMIT) {
        return reply.code(403).send({
          error: 'Plan limit reached',
          message: `Free plan is limited to ${FREE_SERVER_LIMIT} servers. Upgrade to Pro for unlimited servers.`,
          upgrade: true,
        });
      }
    }

    const { data: server, error } = await supabase
      .from('servers')
      .insert({ name, description, is_public, owner_id: userId })
      .select()
      .single();

    if (error) return reply.code(500).send({ error: 'Failed to create server' });

    // Add owner as member
    await supabase.from('server_members').insert({
      server_id: server.id,
      user_id: userId,
      role: 'owner',
    });

    // Create default channels
    await supabase.from('channels').insert([
      { server_id: server.id, name: 'general', type: 'text', position: 0, category: 'Text Channels' },
      { server_id: server.id, name: 'off-topic', type: 'text', position: 1, category: 'Text Channels' },
      { server_id: server.id, name: 'General', type: 'voice', position: 2, category: 'Voice Channels' },
    ]);

    app.io.to(`user:${userId}`).emit('server:created', server);

    return reply.code(201).send(server);
  });

  // ─── Update server ─────────────────────────────────────────────────────
  app.patch('/:serverId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params;
    const userId = req.user.sub;

    const role = await getMemberRole(userId, serverId);
    if (!['owner', 'admin'].includes(role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }

    const allowed = ['name', 'description', 'icon_url', 'banner_url', 'is_public'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data: updated } = await supabase
      .from('servers')
      .update(updates)
      .eq('id', serverId)
      .select()
      .single();

    app.io.to(`server:${serverId}`).emit('server:updated', updated);
    return reply.send(updated);
  });

  // ─── Delete server ─────────────────────────────────────────────────────
  app.delete('/:serverId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params;
    const userId = req.user.sub;

    const { data: server } = await supabase
      .from('servers')
      .select('owner_id')
      .eq('id', serverId)
      .single();

    if (!server) return reply.code(404).send({ error: 'Server not found' });
    if (server.owner_id !== userId) return reply.code(403).send({ error: 'Only the owner can delete this server' });

    await supabase.from('servers').delete().eq('id', serverId);

    app.io.to(`server:${serverId}`).emit('server:deleted', { serverId });
    return reply.send({ message: 'Server deleted' });
  });

  // ─── Join via invite ───────────────────────────────────────────────────
  app.post('/join/:inviteCode', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { inviteCode } = req.params;
    const userId = req.user.sub;

    const { data: server } = await supabase
      .from('servers')
      .select('id, name, icon_url, member_count')
      .eq('invite_code', inviteCode)
      .single();

    if (!server) return reply.code(404).send({ error: 'Invalid invite code' });

    const alreadyMember = await checkMembership(userId, server.id);
    if (alreadyMember) {
      return reply.send({ message: 'Already a member', server });
    }

    // Check plan limit
    if (req.user.plan === 'free') {
      const { count } = await supabase
        .from('server_members')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      if (count >= FREE_SERVER_LIMIT) {
        return reply.code(403).send({
          error: 'Plan limit reached',
          message: 'Free plan is limited to 5 servers.',
          upgrade: true,
        });
      }
    }

    await supabase.from('server_members').insert({
      server_id: server.id,
      user_id: userId,
      role: 'member',
    });

    // Notify server of new member
    const { data: user } = await supabase
      .from('users')
      .select('id, username, display_name, avatar_url')
      .eq('id', userId)
      .single();

    app.io.to(`server:${server.id}`).emit('server:member_joined', { server, user });

    return reply.send({ message: 'Joined server', server });
  });

  // ─── Leave server ──────────────────────────────────────────────────────
  app.delete('/:serverId/leave', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params;
    const userId = req.user.sub;

    const { data: server } = await supabase
      .from('servers')
      .select('owner_id')
      .eq('id', serverId)
      .single();

    if (server?.owner_id === userId) {
      return reply.code(400).send({ error: 'Server owner cannot leave. Transfer ownership or delete the server.' });
    }

    await supabase.from('server_members')
      .delete()
      .eq('server_id', serverId)
      .eq('user_id', userId);

    app.io.to(`server:${serverId}`).emit('server:member_left', { serverId, userId });
    return reply.send({ message: 'Left server' });
  });

  // ─── Get members ───────────────────────────────────────────────────────
  app.get('/:serverId/members', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params;
    const userId = req.user.sub;

    const isMember = await checkMembership(userId, serverId);
    if (!isMember) return reply.code(403).send({ error: 'Not a member' });

    const { data: members } = await supabase
      .from('server_members')
      .select(`
        role, nickname, joined_at,
        user:users(id, username, display_name, avatar_url, status, last_seen_at)
      `)
      .eq('server_id', serverId);

    return reply.send(members || []);
  });

  // ─── Kick member ───────────────────────────────────────────────────────
  app.delete('/:serverId/members/:targetUserId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId, targetUserId } = req.params;
    const userId = req.user.sub;

    const role = await getMemberRole(userId, serverId);
    if (!['owner', 'admin', 'moderator'].includes(role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }

    await supabase.from('server_members')
      .delete()
      .eq('server_id', serverId)
      .eq('user_id', targetUserId);

    app.io.to(`user:${targetUserId}`).emit('server:kicked', { serverId });
    app.io.to(`server:${serverId}`).emit('server:member_left', { serverId, userId: targetUserId });

    return reply.send({ message: 'Member kicked' });
  });

  // ─── Regenerate invite ─────────────────────────────────────────────────
  app.post('/:serverId/invite/regenerate', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params;
    const role = await getMemberRole(req.user.sub, serverId);

    if (!['owner', 'admin'].includes(role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }

    const { data: server } = await supabase
      .from('servers')
      .update({ invite_code: Math.random().toString(36).substring(2, 10) })
      .eq('id', serverId)
      .select('invite_code')
      .single();

    return reply.send({ inviteCode: server.invite_code });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function checkMembership(userId, serverId) {
  const { data } = await supabase
    .from('server_members')
    .select('id')
    .eq('server_id', serverId)
    .eq('user_id', userId)
    .single();
  return !!data;
}

async function getMemberRole(userId, serverId) {
  const { data } = await supabase
    .from('server_members')
    .select('role')
    .eq('server_id', serverId)
    .eq('user_id', userId)
    .single();
  return data?.role || null;
}
