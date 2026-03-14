import { supabase } from '../../db/supabase.js';

export default async function channelRoutes(app) {

  // ─── Get channels for a server ─────────────────────────────────────────
  app.get('/server/:serverId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params;
    const isMember = await checkMembership(req.user.sub, serverId);
    if (!isMember) return reply.code(403).send({ error: 'Not a member' });

    const { data } = await supabase
      .from('channels')
      .select('*')
      .eq('server_id', serverId)
      .order('position', { ascending: true });

    return reply.send(data || []);
  });

  // ─── Create channel ────────────────────────────────────────────────────
  app.post('/', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['server_id', 'name'],
        properties: {
          server_id:  { type: 'string' },
          name:       { type: 'string', minLength: 1, maxLength: 100 },
          type:       { type: 'string', enum: ['text', 'voice', 'announcement', 'stage'] },
          category:   { type: 'string', maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    const { server_id, name, type = 'text', category = 'general', description = '' } = req.body;

    const role = await getMemberRole(req.user.sub, server_id);
    if (!['owner', 'admin'].includes(role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }

    const { count } = await supabase
      .from('channels')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', server_id);

    const { data: channel } = await supabase
      .from('channels')
      .insert({ server_id, name, type, category, description, position: count })
      .select()
      .single();

    app.io.to(`server:${server_id}`).emit('channel:created', channel);
    return reply.code(201).send(channel);
  });

  // ─── Update channel ────────────────────────────────────────────────────
  app.patch('/:channelId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params;

    const { data: channel } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .single();
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    const role = await getMemberRole(req.user.sub, channel.server_id);
    if (!['owner', 'admin'].includes(role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }

    const allowed = ['name', 'description', 'category', 'position', 'slowmode_seconds', 'is_nsfw'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data: updated } = await supabase
      .from('channels')
      .update(updates)
      .eq('id', channelId)
      .select()
      .single();

    app.io.to(`server:${channel.server_id}`).emit('channel:updated', updated);
    return reply.send(updated);
  });

  // ─── Delete channel ────────────────────────────────────────────────────
  app.delete('/:channelId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params;

    const { data: channel } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .single();
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    const role = await getMemberRole(req.user.sub, channel.server_id);
    if (!['owner', 'admin'].includes(role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }

    await supabase.from('channels').delete().eq('id', channelId);
    app.io.to(`server:${channel.server_id}`).emit('channel:deleted', { channelId });
    return reply.send({ message: 'Channel deleted' });
  });
}

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
