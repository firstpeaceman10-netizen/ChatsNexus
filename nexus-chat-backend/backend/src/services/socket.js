import { supabase } from '../db/supabase.js';
import {
  setUserOnline,
  setUserOffline,
  setTyping,
  clearTyping,
  checkMessageRateLimit,
} from './redis.js';

/**
 * Registers all Socket.IO event handlers.
 * Architecture:
 *   - Each server the user is in → they join room `server:{serverId}`
 *   - Each channel → room `channel:{channelId}`
 *   - Each DM → room `dm:{dmChannelId}`
 *   - User's own room → `user:{userId}` (for DM notifications, friend requests)
 */
export function registerSocketHandlers(io, app) {
  // Middleware: verify JWT on socket connect
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) return next(new Error('Authentication required'));

      const payload = app.jwt.verify(token);
      socket.userId = payload.sub;
      socket.userPlan = payload.plan;
      socket.displayName = payload.display_name;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const { userId } = socket;

    // Mark user online
    await setUserOnline(userId, 'online');

    // Join user's personal room
    socket.join(`user:${userId}`);

    // Join all servers the user is a member of
    const { data: memberships } = await supabase
      .from('server_members')
      .select('server_id')
      .eq('user_id', userId);

    if (memberships) {
      for (const m of memberships) {
        socket.join(`server:${m.server_id}`);
      }
    }

    // Notify others that user came online
    broadcastPresenceChange(io, userId, 'online');

    console.log(`🟢 Socket connected: ${socket.displayName} (${userId})`);

    // ─── Channel ──────────────────────────────────────────────────────────

    socket.on('channel:join', async ({ channelId }) => {
      // Verify user has access
      const hasAccess = await verifyChannelAccess(userId, channelId);
      if (!hasAccess) return socket.emit('error', { message: 'No access to this channel' });
      socket.join(`channel:${channelId}`);
      socket.emit('channel:joined', { channelId });
    });

    socket.on('channel:leave', ({ channelId }) => {
      socket.leave(`channel:${channelId}`);
    });

    // ─── Typing ───────────────────────────────────────────────────────────

    socket.on('typing:start', async ({ channelId }) => {
      await setTyping(channelId, userId, socket.displayName);
      socket.to(`channel:${channelId}`).emit('typing:start', {
        userId,
        displayName: socket.displayName,
        channelId,
      });
    });

    socket.on('typing:stop', async ({ channelId }) => {
      await clearTyping(channelId, userId);
      socket.to(`channel:${channelId}`).emit('typing:stop', { userId, channelId });
    });

    // ─── Message send (real-time path) ────────────────────────────────────

    socket.on('message:send', async ({ channelId, content, replyToId, attachments }) => {
      // Rate limit check
      const allowed = await checkMessageRateLimit(userId, socket.userPlan);
      if (!allowed) {
        return socket.emit('error', { message: 'You\'re sending messages too fast.' });
      }

      // Validate
      if (!content?.trim() && (!attachments || attachments.length === 0)) {
        return socket.emit('error', { message: 'Message cannot be empty' });
      }
      if (content?.length > 4000) {
        return socket.emit('error', { message: 'Message too long (max 4000 chars)' });
      }

      // Verify channel access
      const hasAccess = await verifyChannelAccess(userId, channelId);
      if (!hasAccess) return socket.emit('error', { message: 'No access to this channel' });

      try {
        // Get author details
        const { data: author } = await supabase
          .from('users')
          .select('id, username, display_name, avatar_url')
          .eq('id', userId)
          .single();

        // Insert message
        const { data: message, error } = await supabase
          .from('messages')
          .insert({
            channel_id: channelId,
            author_id: userId,
            content: content?.trim() || '',
            reply_to_id: replyToId || null,
            attachments: attachments || [],
          })
          .select('*, author:users(id, username, display_name, avatar_url)')
          .single();

        if (error) throw error;

        // Emit to all in channel
        io.to(`channel:${channelId}`).emit('message:new', {
          ...message,
          author,
        });

        // Stop typing indicator
        await clearTyping(channelId, userId);
        socket.to(`channel:${channelId}`).emit('typing:stop', { userId, channelId });

      } catch (err) {
        console.error('message:send error', err);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ─── Message edit ─────────────────────────────────────────────────────

    socket.on('message:edit', async ({ messageId, content }) => {
      if (!content?.trim()) return;

      const { data: message } = await supabase
        .from('messages')
        .select('author_id, channel_id')
        .eq('id', messageId)
        .single();

      if (!message || message.author_id !== userId) {
        return socket.emit('error', { message: 'Cannot edit this message' });
      }

      const { data: updated } = await supabase
        .from('messages')
        .update({ content: content.trim(), edited_at: new Date().toISOString() })
        .eq('id', messageId)
        .select()
        .single();

      io.to(`channel:${message.channel_id}`).emit('message:edited', {
        messageId,
        content: updated.content,
        editedAt: updated.edited_at,
      });
    });

    // ─── Message delete ───────────────────────────────────────────────────

    socket.on('message:delete', async ({ messageId }) => {
      const { data: message } = await supabase
        .from('messages')
        .select('author_id, channel_id')
        .eq('id', messageId)
        .single();

      if (!message) return;

      // Author or admin can delete
      const canDelete = message.author_id === userId || await isAdminInChannel(userId, message.channel_id);
      if (!canDelete) return socket.emit('error', { message: 'Cannot delete this message' });

      await supabase.from('messages').delete().eq('id', messageId);

      io.to(`channel:${message.channel_id}`).emit('message:deleted', { messageId });
    });

    // ─── Reactions ────────────────────────────────────────────────────────

    socket.on('reaction:add', async ({ messageId, emoji }) => {
      const { data: message } = await supabase
        .from('messages')
        .select('channel_id')
        .eq('id', messageId)
        .single();
      if (!message) return;

      const { error } = await supabase.from('reactions').upsert({
        message_id: messageId,
        user_id: userId,
        emoji,
      });
      if (error) return;

      io.to(`channel:${message.channel_id}`).emit('reaction:add', {
        messageId,
        userId,
        emoji,
      });
    });

    socket.on('reaction:remove', async ({ messageId, emoji }) => {
      const { data: message } = await supabase
        .from('messages')
        .select('channel_id')
        .eq('id', messageId)
        .single();
      if (!message) return;

      await supabase.from('reactions').delete()
        .eq('message_id', messageId)
        .eq('user_id', userId)
        .eq('emoji', emoji);

      io.to(`channel:${message.channel_id}`).emit('reaction:remove', {
        messageId,
        userId,
        emoji,
      });
    });

    // ─── DM ───────────────────────────────────────────────────────────────

    socket.on('dm:join', async ({ dmChannelId }) => {
      const isParticipant = await verifyDmAccess(userId, dmChannelId);
      if (!isParticipant) return socket.emit('error', { message: 'No access' });
      socket.join(`dm:${dmChannelId}`);
    });

    socket.on('dm:send', async ({ dmChannelId, content, replyToId }) => {
      const isParticipant = await verifyDmAccess(userId, dmChannelId);
      if (!isParticipant) return socket.emit('error', { message: 'No access' });

      if (!content?.trim()) return;

      const { data: message, error } = await supabase
        .from('dm_messages')
        .insert({
          dm_channel_id: dmChannelId,
          author_id: userId,
          content: content.trim(),
          reply_to_id: replyToId || null,
        })
        .select('*, author:users(id, username, display_name, avatar_url)')
        .single();

      if (error) return socket.emit('error', { message: 'Failed to send DM' });

      // Notify all DM participants
      io.to(`dm:${dmChannelId}`).emit('dm:message', message);

      // Also notify participants who aren't in the DM room (unread badge)
      const { data: participants } = await supabase
        .from('dm_participants')
        .select('user_id')
        .eq('dm_channel_id', dmChannelId)
        .neq('user_id', userId);

      for (const p of participants || []) {
        io.to(`user:${p.user_id}`).emit('dm:notification', {
          dmChannelId,
          message,
        });
      }
    });

    // ─── Presence ─────────────────────────────────────────────────────────

    socket.on('presence:update', async ({ status }) => {
      const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
      if (!validStatuses.includes(status)) return;

      await setUserOnline(userId, status);
      await supabase.from('users').update({ status }).eq('id', userId);

      broadcastPresenceChange(io, userId, status);
    });

    // ─── Voice channel ────────────────────────────────────────────────────

    socket.on('voice:join', async ({ channelId }) => {
      const hasAccess = await verifyChannelAccess(userId, channelId);
      if (!hasAccess) return;

      socket.join(`voice:${channelId}`);
      socket.to(`voice:${channelId}`).emit('voice:user_joined', {
        userId,
        displayName: socket.displayName,
      });

      // Notify server members
      const { data: channel } = await supabase
        .from('channels')
        .select('server_id')
        .eq('id', channelId)
        .single();

      if (channel) {
        io.to(`server:${channel.server_id}`).emit('voice:state_update', {
          channelId,
          userId,
          action: 'join',
        });
      }
    });

    socket.on('voice:leave', async ({ channelId }) => {
      socket.leave(`voice:${channelId}`);
      socket.to(`voice:${channelId}`).emit('voice:user_left', { userId });
    });

    // WebRTC signaling
    socket.on('voice:signal', ({ to, signal }) => {
      io.to(`user:${to}`).emit('voice:signal', { from: userId, signal });
    });

    // ─── Disconnect ───────────────────────────────────────────────────────

    socket.on('disconnect', async () => {
      await setUserOffline(userId);
      await supabase.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', userId);
      broadcastPresenceChange(io, userId, 'offline');
      console.log(`🔴 Socket disconnected: ${socket.displayName} (${userId})`);
    });
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

  const { data: member } = await supabase
    .from('server_members')
    .select('id')
    .eq('server_id', channel.server_id)
    .eq('user_id', userId)
    .single();

  return !!member;
}

async function verifyDmAccess(userId, dmChannelId) {
  const { data } = await supabase
    .from('dm_participants')
    .select('user_id')
    .eq('dm_channel_id', dmChannelId)
    .eq('user_id', userId)
    .single();
  return !!data;
}

async function isAdminInChannel(userId, channelId) {
  const { data: channel } = await supabase
    .from('channels')
    .select('server_id')
    .eq('id', channelId)
    .single();

  if (!channel) return false;

  const { data: member } = await supabase
    .from('server_members')
    .select('role')
    .eq('server_id', channel.server_id)
    .eq('user_id', userId)
    .single();

  return member?.role && ['owner', 'admin', 'moderator'].includes(member.role);
}

async function broadcastPresenceChange(io, userId, status) {
  // Emit to all servers this user is in
  const { data: memberships } = await supabase
    .from('server_members')
    .select('server_id')
    .eq('user_id', userId);

  if (memberships) {
    for (const m of memberships) {
      io.to(`server:${m.server_id}`).emit('presence:update', { userId, status });
    }
  }
}
