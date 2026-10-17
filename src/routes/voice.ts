import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AccessToken } from 'livekit-server-sdk';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

export const voiceRoutes: FastifyPluginAsync = async (app) => {
  // Generate LiveKit access token for joining a voice channel
  app.get('/token', { preHandler: authenticate }, async (request, reply) => {
    const { channelId } = request.query as { channelId?: string };

    if (!channelId) {
      return reply.status(400).send({ error: 'channelId is required' });
    }

    // Verify channel exists and is a voice channel
    const channelResult = await pool.query(
      `SELECT c.*, s.id as server_id FROM channels c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.id = ?`,
      [channelId]
    );

    if (channelResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const channel = channelResult.rows[0];

    if (channel.type !== 'voice' && channel.type !== 'video') {
      return reply.status(400).send({ error: 'Channel is not a voice or video channel' });
    }

    // Check membership if server channel
    if (channel.server_id) {
      const membership = await pool.query(
        `SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`,
        [channel.server_id, request.user!.userId]
      );

      if (membership.rows.length === 0) {
        return reply.status(403).send({ error: 'Not authorized to join this channel' });
      }
    }

    // Check if LiveKit is configured
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return reply.status(503).send({
        error: 'Voice service not configured. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env',
        setupUrl: 'https://cloud.livekit.io/',
      });
    }

    // Get user info for the token
    const userResult = await pool.query(
      `SELECT username, display_name FROM users WHERE id = ?`,
      [request.user!.userId]
    );

    const user = userResult.rows[0];

    // Generate LiveKit token
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: request.user!.userId,
      name: user.display_name || user.username,
      ttl: '1h',
    });

    token.addGrant({
      roomJoin: true,
      room: `channel_${channelId}`,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await token.toJwt();

    return {
      token: jwt,
      url: process.env.LIVEKIT_URL || 'wss://your-project.livekit.cloud',
      roomName: `channel_${channelId}`,
    };
  });

  // Get voice state for a channel (who's connected)
  app.get('/channels/:channelId/state', { preHandler: authenticate }, async (request, reply) => {
    const { channelId } = request.params as { channelId: string };

    // In production, this would query LiveKit's room API
    return {
      channelId,
      participants: [],
    };
  });

  // Mute/unmute a participant (moderator action)
  app.post('/channels/:channelId/mute', { preHandler: authenticate }, async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const body = z.object({
      targetUserId: z.string(),
      muted: z.boolean(),
    }).parse(request.body);

    // TODO: Implement with LiveKit RoomServiceClient
    return { success: true };
  });

  // Disconnect a participant (moderator action)
  app.post('/channels/:channelId/disconnect', { preHandler: authenticate }, async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const body = z.object({
      targetUserId: z.string(),
    }).parse(request.body);

    // TODO: Implement with LiveKit RoomServiceClient
    return { success: true };
  });
};