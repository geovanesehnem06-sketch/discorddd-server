import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
const createServerSchema = z.object({
    name: z.string().min(2).max(100),
    description: z.string().max(500).optional(),
});
const updateServerSchema = z.object({
    name: z.string().min(2).max(100).optional(),
    description: z.string().max(500).optional(),
    iconUrl: z.string().url().optional(),
});
export const serverRoutes = async (app) => {
    // Get all servers the user is a member of
    app.get('/', { preHandler: authenticate }, async (request) => {
        const result = await pool.query(`SELECT s.id, s.name, s.description, s.icon_url, s.owner_id, s.created_at
       FROM servers s
       JOIN server_members sm ON sm.server_id = s.id
       WHERE sm.user_id = ?
       ORDER BY s.created_at ASC`, [request.user.userId]);
        return { servers: result.rows };
    });
    // Create a new server
    app.post('/', { preHandler: authenticate }, async (request, reply) => {
        const body = createServerSchema.parse(request.body);
        const userId = request.user.userId;
        // Insert server
        const result = pool.query(`INSERT INTO servers (name, description, owner_id)
       VALUES (?, ?, ?)`, [body.name, body.description || null, userId]);
        // Get the actual server ID from the returned row
        const serverId = result.rows[0]?.id || result.lastInsertRowid;
        if (!serverId) {
            return reply.status(500).send({ error: 'Failed to create server' });
        }
        // Add owner as member
        pool.query(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, [serverId, userId]);
        // Create default @everyone role
        pool.query(`INSERT INTO roles (server_id, name, position, permissions, is_default)
       VALUES (?, '@everyone', 0, 0, 1)`, [serverId]);
        // Create default text channel
        pool.query(`INSERT INTO channels (server_id, name, type, position)
       VALUES (?, 'geral', 'text', 0)`, [serverId]);
        // Create default voice channel
        pool.query(`INSERT INTO channels (server_id, name, type, position)
       VALUES (?, 'Geral', 'voice', 1)`, [serverId]);
        // Get the created server - try by id first, then by rowid
        let serverResult = pool.query('SELECT id, name, description, icon_url, owner_id, created_at FROM servers WHERE id = ?', [serverId]);
        // If not found by id, try getting the last inserted server
        if (serverResult.rows.length === 0) {
            serverResult = pool.query('SELECT id, name, description, icon_url, owner_id, created_at FROM servers ORDER BY rowid DESC LIMIT 1');
        }
        if (serverResult.rows.length === 0) {
            return reply.status(500).send({ error: 'Failed to retrieve created server' });
        }
        return reply.status(201).send(serverResult.rows[0]);
    });
    // Get server by ID
    app.get('/:id', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        // Check if user is a member
        const membership = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [id, request.user.userId]);
        if (membership.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }
        const result = await pool.query(`SELECT id, name, description, icon_url, owner_id, created_at FROM servers WHERE id = ?`, [id]);
        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'Server not found' });
        }
        return result.rows[0];
    });
    // Update server
    app.patch('/:id', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const body = updateServerSchema.parse(request.body);
        // Check if user is owner
        const server = await pool.query(`SELECT owner_id FROM servers WHERE id = ?`, [id]);
        if (server.rows.length === 0) {
            return reply.status(404).send({ error: 'Server not found' });
        }
        if (server.rows[0].owner_id !== request.user.userId) {
            return reply.status(403).send({ error: 'Only the owner can update the server' });
        }
        const updates = [];
        const values = [];
        if (body.name !== undefined) {
            updates.push(`name = ?`);
            values.push(body.name);
        }
        if (body.description !== undefined) {
            updates.push(`description = ?`);
            values.push(body.description);
        }
        if (body.iconUrl !== undefined) {
            updates.push(`icon_url = ?`);
            values.push(body.iconUrl);
        }
        if (updates.length === 0) {
            return reply.status(400).send({ error: 'No fields to update' });
        }
        updates.push(`updated_at = datetime('now')`);
        values.push(id);
        const result = await pool.query(`UPDATE servers SET ${updates.join(', ')} WHERE id = ? RETURNING *`, values);
        // SQLite doesn't support RETURNING, so fetch separately
        const updated = await pool.query('SELECT * FROM servers WHERE id = ?', [id]);
        return updated.rows[0];
    });
    // Delete server
    app.delete('/:id', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const server = await pool.query(`SELECT owner_id FROM servers WHERE id = ?`, [id]);
        if (server.rows.length === 0) {
            return reply.status(404).send({ error: 'Server not found' });
        }
        if (server.rows[0].owner_id !== request.user.userId) {
            return reply.status(403).send({ error: 'Only the owner can delete the server' });
        }
        await pool.query(`DELETE FROM servers WHERE id = ?`, [id]);
        return { success: true };
    });
    // Get server members
    app.get('/:id/members', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        // Check membership
        const membership = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [id, request.user.userId]);
        if (membership.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }
        const result = await pool.query(`SELECT u.id, u.username, u.display_name, u.avatar_url, u.status, sm.nickname, sm.joined_at
       FROM server_members sm
       JOIN users u ON u.id = sm.user_id
       WHERE sm.server_id = ?
       ORDER BY u.username ASC`, [id]);
        return { members: result.rows };
    });
    // Get server channels
    app.get('/:id/channels', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        // Check membership
        const membership = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [id, request.user.userId]);
        if (membership.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }
        const result = await pool.query(`SELECT id, server_id, parent_id, name, type, topic, position, nsfw, bitrate, user_limit
       FROM channels
       WHERE server_id = ?
       ORDER BY position ASC`, [id]);
        return { channels: result.rows };
    });
    // Join server via invite
    app.post('/:id/join', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const userId = request.user.userId;
        // Check if already a member
        const existing = await pool.query(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`, [id, userId]);
        if (existing.rows.length > 0) {
            return reply.status(400).send({ error: 'Already a member' });
        }
        await pool.query(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, [id, userId]);
        return { success: true };
    });
    // Leave server
    app.post('/:id/leave', { preHandler: authenticate }, async (request, reply) => {
        const { id } = request.params;
        const userId = request.user.userId;
        // Check if owner
        const server = await pool.query(`SELECT owner_id FROM servers WHERE id = ?`, [id]);
        if (server.rows.length === 0) {
            return reply.status(404).send({ error: 'Server not found' });
        }
        if (server.rows[0].owner_id === userId) {
            return reply.status(400).send({ error: 'Owner cannot leave, must delete server instead' });
        }
        await pool.query(`DELETE FROM server_members WHERE server_id = ? AND user_id = ?`, [id, userId]);
        return { success: true };
    });
};
//# sourceMappingURL=servers.js.map