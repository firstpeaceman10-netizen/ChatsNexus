import { supabase } from '../../db/supabase.js';

const MESSAGE_HISTORY_DAYS_FREE = 90;

export default async function messageRoutes(app) {

  // ─── Get messages (paginated) ──────────────────────────────────────────
  app.get('/channel/:channelId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params;
    const { before, limit = 50 } = req.query;
    const userId = req.user.sub;

    const hasAccess = await verifyChannelAccess(userId, channelId);
    if (!hasAccess) return reply.code(403).send({ error: 'No access' });

    let query = supabase
      .from('messages')
      .select(`
        id, content, type, reply_to_id, edited_at, is_pinned,
        attachments, embeds, mentions, created_at,
        author:users(id, username, display_name, avatar_url),
        reactions(emoji, user_id)
      `)
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit), 100));

    if (before) {
      query = query.lt('created_at', before);
    }

    // Enforce message history limit for free plan
    if (req.user.plan === 'free') {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - MESSAGE_HISTORY_DAYS_FREE);
      query = query.gte('created_at', cutoff.toISOString());
    }

    const { data: messages, error } = await query;
    if (error) return reply.code(500).send({ error: 'Failed to load messages' });

    return reply.send((messages || []).reverse());
  });

  // ─── Get pinned messages ───────────────────────────────────────────────
  app.get('/channel/:channelId/pinned', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params;
    const hasAccess = await verifyChannelAccess(req.user.sub, channelId);
    if (!hasAccess) return reply.code(403).send({ error: 'No access' });

    const { data } = await supabase
      .from('messages')
      .select(`*, author:users(id, username, display_name, avatar_url)`)
      .eq('channel_id', channelId)
      .eq('is_pinned', true)
      .order('created_at', { ascending: false });

    return reply.send(data || []);
  });

  // ─── Pin / unpin ───────────────────────────────────────────────────────
  app.patch('/:messageId/pin', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { messageId } = req.params;
    const { pinned } = req.body;

    const { data: msg } = await supabase
      .from('messages')
      .select('channel_id')
      .eq('id', messageId)
      .single();
    if (!msg) return reply.code(404).send({ error: 'Message not found' });

    const canModerate = await isModeratorInChannel(req.user.sub, msg.channel_id);
    if (!canModerate) return reply.code(403).send({ error: 'Insufficient permissions' });

    await supabase.from('messages').update({ is_pinned: pinned }).eq('id', messageId);
    app.io.to(`channel:${msg.channel_id}`).emit('message:pin_updated', { messageId, pinned });
    return reply.send({ message: pinned ? 'Message pinned' : 'Message unpinned' });
  });

  // ─── Search messages ───────────────────────────────────────────────────
  app.get('/channel/:channelId/search', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params;
    const { q, limit = 20 } = req.query;
    if (!q || q.length < 2) return reply.send([]);

    const hasAccess = await verifyChannelAccess(req.user.sub, channelId);
    if (!hasAccess) return reply.code(403).send({ error: 'No access' });

    const { data } = await supabase
      .from('messages')
      .select(`*, author:users(id, username, display_name, avatar_url)`)
      .eq('channel_id', channelId)
      .ilike('content', `%${q}%`)
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit), 50));

    return reply.send(data || []);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function verifyChannelAccess(userId, channelId) {
  const { data: channel } = await supabase
    .from('channels')
    .select('server_id')
    .eq('id', channelId)
    .single();
  if (!channel) return false;

  const { data } = await supabase
    .from('server_members')
    .select('id')
    .eq('server_id', channel.server_id)
    .eq('user_id', userId)
    .single();
  return !!data;
}

async function isModeratorInChannel(userId, channelId) {
  const { data: channel } = await supabase
    .from('channels')
    .select('server_id')
    .eq('id', channelId)
    .single();
  if (!channel) return false;

  const { data } = await supabase
    .from('server_members')
    .select('role')
    .eq('server_id', channel.server_id)
    .eq('user_id', userId)
    .single();
  return ['owner', 'admin', 'moderator'].includes(data?.role);
}
