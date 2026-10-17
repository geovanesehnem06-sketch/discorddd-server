import { z } from 'zod';
import { randomBytes } from 'crypto';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { broadcastToChannel } from '../ws/handler.js';
function generateId() {
    return randomBytes(16).toString('hex');
}
const createChannelSchema = z.object({
    serverId: z.string(),
    name: z.string().min(1).max(100),
    type: z.enum(['text', 'voice', 'video', 'category', 'announcement', 'forum']),
    parentId: z.string().optional(),
    topic: z.string().max(500).optional(),
    position: z.number().int().min(0).optional(),
    nsfw: z.boolean().optional(),
    bitrate: z.number().int().min(8000).max(384000).optional(),
    userLimit: z.number().int().min(0).max(99).optional(),
});
const sendMessageSchema = z.object({
    content: z.string().min(1).max(2000),
    replyToId: z.string().optional(),
});
export const channelRoutes = async (app) => {
    // Create channel in a server
    app.post('/', { preHandler: authenticate }, async (request, reply) => {
        const body = createChannelSchema.parse(request.body);
        // Check if user is a member
        const membership = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [body.serverId, request.user.userId]);
        if (membership.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }
        const channelId = generateId();
        pool.query(`INSERT INTO channels (id, server_id, parent_id, name, type, topic, position, nsfw, bitrate, user_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            channelId,
            body.serverId,
            body.parentId || null,
            body.name,
            body.type,
            body.topic || null,
            body.position || 0,
            body.nsfw ? 1 : 0,
            body.bitrate || null,
            body.userLimit || null,
        ]);
        return reply.status(201).send({
            id: channelId,
            server_id: body.serverId,
            parent_id: body.parentId || null,
            name: body.name,
            type: body.type,
            topic: body.topic || null,
            position: body.position || 0,
            nsfw: body.nsfw ? 1 : 0,
            bitrate: body.bitrate || null,
            user_limit: body.userLimit || null,
        });
    });
    // Get channel by ID
    app.get('/:id', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const result = await pool.query(`SELECT c.*, s.id as server_id_check
       FROM channels c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.id = ?`, [id]);
        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'Channel not found' });
        }
        const channel = result.rows[0];
        // If channel belongs to a server, check membership
        if (channel.server_id) {
            const membership = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [channel.server_id, request.user.userId]);
            if (membership.rows.length === 0) {
                return reply.status(403).send({ error: 'Not authorized' });
            }
        }
        return channel;
    });
    // Update channel
    app.patch('/:id', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = z.object({
            name: z.string().min(1).max(100).optional(),
            topic: z.string().max(500).optional(),
            position: z.number().int().min(0).optional(),
            nsfw: z.boolean().optional(),
            bitrate: z.number().int().min(8000).max(384000).optional(),
            userLimit: z.number().int().min(0).max(99).optional(),
        }).parse(request.body);
        // Get channel and check permissions
        const channelResult = await pool.query(`SELECT c.*, s.owner_id FROM channels c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.id = ?`, [id]);
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Channel not found' });
        }
        const channel = channelResult.rows[0];
        // Check if user has permission
        if (channel.server_id) {
            const membership = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [channel.server_id, request.user.userId]);
            if (membership.rows.length === 0) {
                return reply.status(403).send({ error: 'Not authorized' });
            }
        }
        const updates = [];
        const values = [];
        if (body.name !== undefined) {
            updates.push(`name = ?`);
            values.push(body.name);
        }
        if (body.topic !== undefined) {
            updates.push(`topic = ?`);
            values.push(body.topic);
        }
        if (body.position !== undefined) {
            updates.push(`position = ?`);
            values.push(body.position);
        }
        if (body.nsfw !== undefined) {
            updates.push(`nsfw = ?`);
            values.push(body.nsfw ? 1 : 0);
        }
        if (body.bitrate !== undefined) {
            updates.push(`bitrate = ?`);
            values.push(body.bitrate);
        }
        if (body.userLimit !== undefined) {
            updates.push(`user_limit = ?`);
            values.push(body.userLimit);
        }
        if (updates.length === 0) {
            return reply.status(400).send({ error: 'No fields to update' });
        }
        updates.push(`updated_at = datetime('now')`);
        values.push(id);
        await pool.query(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`, values);
        const updated = await pool.query('SELECT * FROM channels WHERE id = ?', [id]);
        return updated.rows[0];
    });
    // Delete channel
    app.delete('/:id', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const channelResult = await pool.query(`SELECT c.*, s.owner_id FROM channels c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.id = ?`, [id]);
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Channel not found' });
        }
        const channel = channelResult.rows[0];
        if (channel.server_id && channel.owner_id !== request.user.userId) {
            return reply.status(403).send({ error: 'Not authorized to delete this channel' });
        }
        await pool.query(`DELETE FROM channels WHERE id = ?`, [id]);
        return { success: true };
    });
    // Get messages for a channel
    app.get('/:id/messages', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const { limit = 50, before } = request.query;
        // Get channel and check access
        const channelResult = await pool.query(`SELECT c.*, s.id as server_id FROM channels c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.id = ?`, [id]);
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Channel not found' });
        }
        const channel = channelResult.rows[0];
        // Check membership if server channel
        if (channel.server_id) {
            const membership = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [channel.server_id, request.user.userId]);
            if (membership.rows.length === 0) {
                return reply.status(403).send({ error: 'Not authorized' });
            }
        }
        // Build query with pagination
        let queryStr = `
      SELECT m.*, u.username as author_name, u.display_name as author_display_name, u.avatar_url as author_avatar
      FROM messages m
      JOIN users u ON u.id = m.author_id
      WHERE m.channel_id = ?
    `;
        const params = [id];
        if (before) {
            queryStr += ` AND m.created_at < (SELECT created_at FROM messages WHERE id = ?)`;
            params.push(before);
        }
        queryStr += ` ORDER BY m.created_at DESC LIMIT ?`;
        params.push(Math.min(Number(limit) || 50, 100));
        const result = await pool.query(queryStr, params);
        return {
            messages: result.rows.reverse(), // Return in chronological order
        };
    });
    // Send message to a channel
    app.post('/:id/messages', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = sendMessageSchema.parse(request.body);
        // Get channel and check access
        const channelResult = await pool.query(`SELECT c.*, s.id as server_id FROM channels c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.id = ?`, [id]);
        if (channelResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Channel not found' });
        }
        const channel = channelResult.rows[0];
        // Check membership if server channel
        if (channel.server_id) {
            const membership = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [channel.server_id, request.user.userId]);
            if (membership.rows.length === 0) {
                return reply.status(403).send({ error: 'Not authorized' });
            }
        }
        // Insert message
        const insertResult = await pool.query(`INSERT INTO messages (channel_id, author_id, content, reply_to_id)
       VALUES (?, ?, ?, ?)`, [id, request.user.userId, body.content, body.replyToId || null]);
        // Get the full message with author info
        const messageResult = await pool.query(`SELECT m.*, u.username as author_name, u.display_name as author_display_name, u.avatar_url as author_avatar
       FROM messages m
       JOIN users u ON u.id = m.author_id
       WHERE m.id = ?`, [insertResult.lastInsertRowid]);
        const message = messageResult.rows[0];
        // Broadcast to WebSocket subscribers
        broadcastToChannel(id, {
            type: 'message_created',
            message,
        }, request.user.userId);
        return reply.status(201).send(message);
    });
};
//# sourceMappingURL=channels.js.map