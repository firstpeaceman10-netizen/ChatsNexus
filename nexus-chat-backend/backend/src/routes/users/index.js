import bcrypt from 'bcryptjs';
import { supabase } from '../../db/supabase.js';

export default async function userRoutes(app) {

  // ─── Get user profile ──────────────────────────────────────────────────
  app.get('/:userId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { data: user } = await supabase
      .from('users')
      .select('id, username, display_name, avatar_url, banner_url, bio, status, created_at, last_seen_at')
      .eq('id', req.params.userId)
      .single();

    if (!user) return reply.code(404).send({ error: 'User not found' });
    return reply.send(user);
  });

  // ─── Update own profile ────────────────────────────────────────────────
  app.patch('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const allowed = ['display_name', 'bio', 'avatar_url', 'banner_url', 'status', 'custom_status'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update' });
    }

    const { data: user } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select('id, username, display_name, avatar_url, banner_url, bio, status, custom_status, plan')
      .single();

    // Broadcast presence/profile update to servers
    const { data: memberships } = await supabase
      .from('server_members')
      .select('server_id')
      .eq('user_id', userId);

    for (const m of memberships || []) {
      app.io.to(`server:${m.server_id}`).emit('user:updated', {
        userId,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        status: user.status,
      });
    }

    return reply.send(user);
  });

  // ─── Change password ───────────────────────────────────────────────────
  app.post('/me/change-password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password || new_password.length < 8) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('password_hash')
      .eq('id', req.user.sub)
      .single();

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return reply.code(401).send({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await supabase.from('users').update({ password_hash: hash }).eq('id', req.user.sub);

    return reply.send({ message: 'Password updated' });
  });

  // ─── Get settings ──────────────────────────────────────────────────────
  app.get('/me/settings', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { data } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', req.user.sub)
      .single();
    return reply.send(data || {});
  });

  // ─── Update settings ───────────────────────────────────────────────────
  app.patch('/me/settings', { preHandler: [app.authenticate] }, async (req, reply) => {
    const allowed = ['theme', 'locale', 'notifications', 'accessibility', 'message_display'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data } = await supabase
      .from('user_settings')
      .upsert({ user_id: req.user.sub, ...updates }, { onConflict: 'user_id' })
      .select()
      .single();

    return reply.send(data);
  });

  // ─── Search users ──────────────────────────────────────────────────────
  app.get('/search', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { q, limit = 10 } = req.query;
    if (!q || q.length < 2) return reply.send([]);

    const { data } = await supabase
      .from('users')
      .select('id, username, display_name, avatar_url')
      .ilike('username', `%${q}%`)
      .neq('id', req.user.sub)
      .limit(Math.min(parseInt(limit), 20));

    return reply.send(data || []);
  });

  // ─── Friends ───────────────────────────────────────────────────────────

  app.get('/me/friends', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { data } = await supabase
      .from('friendships')
      .select(`
        id, status, created_at,
        friend:users!friendships_friend_id_fkey(id, username, display_name, avatar_url, status)
      `)
      .eq('user_id', req.user.sub);
    return reply.send(data || []);
  });

  app.post('/me/friends/:targetUserId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { targetUserId } = req.params;
    const userId = req.user.sub;
    if (userId === targetUserId) return reply.code(400).send({ error: 'Cannot friend yourself' });

    const { error } = await supabase.from('friendships').insert([
      { user_id: userId, friend_id: targetUserId, status: 'pending' },
    ]);
    if (error?.code === '23505') return reply.code(409).send({ error: 'Request already sent' });

    // Notify target user
    const { data: sender } = await supabase
      .from('users')
      .select('id, username, display_name, avatar_url')
      .eq('id', userId)
      .single();

    app.io.to(`user:${targetUserId}`).emit('friend:request', { from: sender });
    return reply.code(201).send({ message: 'Friend request sent' });
  });

  app.patch('/me/friends/:friendshipId/accept', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { friendshipId } = req.params;

    const { data: friendship } = await supabase
      .from('friendships')
      .select('*')
      .eq('id', friendshipId)
      .eq('friend_id', req.user.sub)
      .single();

    if (!friendship) return reply.code(404).send({ error: 'Friendship not found' });

    await supabase.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);

    // Create reverse friendship
    await supabase.from('friendships').upsert({
      user_id: req.user.sub,
      friend_id: friendship.user_id,
      status: 'accepted',
    });

    app.io.to(`user:${friendship.user_id}`).emit('friend:accepted', { userId: req.user.sub });
    return reply.send({ message: 'Friend request accepted' });
  });

  app.delete('/me/friends/:targetUserId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const { targetUserId } = req.params;

    await supabase.from('friendships')
      .delete()
      .or(`and(user_id.eq.${userId},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${userId})`);

    return reply.send({ message: 'Friend removed' });
  });

  // ─── DM Channels ──────────────────────────────────────────────────────

  app.get('/me/dms', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { data: participations } = await supabase
      .from('dm_participants')
      .select(`
        dm_channel_id,
        dm_channel:dm_channels(id, created_at)
      `)
      .eq('user_id', req.user.sub);

    const dmChannelIds = participations?.map(p => p.dm_channel_id) || [];
    if (dmChannelIds.length === 0) return reply.send([]);

    // Get the other participants
    const { data: allParticipants } = await supabase
      .from('dm_participants')
      .select(`user:users(id, username, display_name, avatar_url, status), dm_channel_id`)
      .in('dm_channel_id', dmChannelIds)
      .neq('user_id', req.user.sub);

    return reply.send(
      participations?.map(p => ({
        id: p.dm_channel_id,
        created_at: p.dm_channel?.created_at,
        participants: allParticipants
          ?.filter(ap => ap.dm_channel_id === p.dm_channel_id)
          .map(ap => ap.user),
      })) || []
    );
  });

  app.post('/me/dms/:targetUserId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const { targetUserId } = req.params;

    // Check if DM already exists
    const { data: existing } = await supabase
      .from('dm_participants')
      .select('dm_channel_id')
      .eq('user_id', userId);

    const myChannelIds = existing?.map(e => e.dm_channel_id) || [];

    if (myChannelIds.length > 0) {
      const { data: sharedChannel } = await supabase
        .from('dm_participants')
        .select('dm_channel_id')
        .eq('user_id', targetUserId)
        .in('dm_channel_id', myChannelIds)
        .single();

      if (sharedChannel) return reply.send({ dmChannelId: sharedChannel.dm_channel_id });
    }

    // Create new DM channel
    const { data: dm } = await supabase
      .from('dm_channels')
      .insert({})
      .select()
      .single();

    await supabase.from('dm_participants').insert([
      { dm_channel_id: dm.id, user_id: userId },
      { dm_channel_id: dm.id, user_id: targetUserId },
    ]);

    app.io.to(`user:${targetUserId}`).emit('dm:new_channel', { dmChannelId: dm.id });
    return reply.code(201).send({ dmChannelId: dm.id });
  });
}
