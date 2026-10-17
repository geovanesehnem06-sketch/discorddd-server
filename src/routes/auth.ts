import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { pool } from '../db/pool.js';
import { authenticate, signAccessToken, signRefreshToken } from '../middleware/auth.js';
import crypto from 'crypto';

function generateId(): string {
  return randomBytes(16).toString('hex');
}

const registerSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  username: z.string().optional(),
  email: z.string().min(1),
  password: z.string(),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

const googleLoginSchema = z.object({
  idToken: z.string(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/register', async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);

      const existing = await pool.query(
        'SELECT id FROM users WHERE email = ? OR username = ?',
        [body.email.toLowerCase(), body.username]
      );

      if (existing.rows.length > 0) {
        return reply.status(409).send({ error: 'Email or username already exists' });
      }

      const passwordHash = await argon2.hash(body.password);
      const userId = generateId();

      pool.query(
        `INSERT INTO users (id, username, email, password_hash, display_name)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, body.username, body.email.toLowerCase(), passwordHash, body.username]
      );

      const user = { id: userId, username: body.username, email: body.email.toLowerCase(), display_name: body.username };

      const accessToken = signAccessToken(user.id, user.email);
      const refreshToken = signRefreshToken(user.id);

      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      pool.query(
        `INSERT INTO sessions (user_id, refresh_token, device_info, ip_address, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [user.id, refreshTokenHash, request.headers['user-agent'] || '', request.ip || '', expiresAt]
      );

      return reply.status(201).send({
        user: { id: user.id, username: user.username, email: user.email, displayName: user.display_name },
        accessToken,
        refreshToken,
      });
    } catch (err: any) {
      console.error('Register error:', err);
      return reply.status(500).send({ error: err.message || 'Internal server error' });
    }
  });

  app.post('/login', async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      const identifier = body.email.toLowerCase().trim();

      const result = await pool.query(
        'SELECT id, email, password_hash, username, display_name FROM users WHERE email = ? OR username = ?',
        [identifier, identifier]
      );

      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];
      const valid = await argon2.verify(user.password_hash, body.password);

      if (!valid) {
        return reply.status(401).send({ error: 'Invalid credentials' });
      }

      const accessToken = signAccessToken(user.id, user.email);
      const refreshToken = signRefreshToken(user.id);

      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      pool.query(
        `INSERT INTO sessions (user_id, refresh_token, device_info, ip_address, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [user.id, refreshTokenHash, request.headers['user-agent'] || '', request.ip || '', expiresAt]
      );

      return {
        user: { id: user.id, username: user.username, email: user.email, displayName: user.display_name },
        accessToken,
        refreshToken,
      };
    } catch (err: any) {
      console.error('Login error:', err);
      return reply.status(500).send({ error: err.message || 'Internal server error' });
    }
  });

  app.post('/google', async (request, reply) => {
    try {
      const body = googleLoginSchema.parse(request.body);

      const tokenParts = body.idToken.split('.');
      if (tokenParts.length !== 3) {
        return reply.status(400).send({ error: 'Invalid Google token' });
      }

      const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
      const { email, name, picture, sub: googleId } = payload;

      if (!email) {
        return reply.status(400).send({ error: 'Google token missing email' });
      }

      let userResult = await pool.query(
        'SELECT id, username, email, display_name, avatar_url FROM users WHERE email = ?',
        [email.toLowerCase()]
      );

      let user;
      if (userResult.rows.length === 0) {
        const username = email.split('@')[0] + '_' + Math.random().toString(36).substring(2, 8);
        const displayName = name || username;
        const googleUserId = generateId();

        pool.query(
          `INSERT INTO users (id, username, email, password_hash, display_name, avatar_url)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [googleUserId, username, email.toLowerCase(), 'google_oauth_' + googleId, displayName, picture || null]
        );

        user = { id: googleUserId, username, email: email.toLowerCase(), display_name: displayName, avatar_url: picture || null };
      } else {
        user = userResult.rows[0];
      }

      const accessToken = signAccessToken(user.id, user.email);
      const refreshToken = signRefreshToken(user.id);

      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      pool.query(
        `INSERT INTO sessions (user_id, refresh_token, device_info, ip_address, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [user.id, refreshTokenHash, request.headers['user-agent'] || '', request.ip || '', expiresAt]
      );

      return {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.display_name,
          avatarUrl: user.avatar_url
        },
        accessToken,
        refreshToken,
      };
    } catch (err: any) {
      console.error('Google login error:', err);
      return reply.status(500).send({ error: err.message || 'Google login failed' });
    }
  });

  app.post('/refresh', async (request, reply) => {
    try {
      const body = refreshSchema.parse(request.body);
      const refreshTokenHash = crypto.createHash('sha256').update(body.refreshToken).digest('hex');

      const session = await pool.query(
        `SELECT s.user_id, u.email FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.refresh_token = ? AND s.expires_at > datetime('now')`,
        [refreshTokenHash]
      );

      if (session.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid or expired refresh token' });
      }

      const { user_id, email } = session.rows[0];

      pool.query('DELETE FROM sessions WHERE refresh_token = ?', [refreshTokenHash]);

      const newAccessToken = signAccessToken(user_id, email);
      const newRefreshToken = signRefreshToken(user_id);
      const newHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      pool.query(
        `INSERT INTO sessions (user_id, refresh_token, device_info, ip_address, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [user_id, newHash, request.headers['user-agent'] || '', request.ip || '', expiresAt]
      );

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    } catch (err: any) {
      console.error('Refresh error:', err);
      return reply.status(500).send({ error: err.message || 'Refresh failed' });
    }
  });

  app.post('/logout', { preHandler: authenticate }, async (request, reply) => {
    return { success: true };
  });

  app.get('/me', { preHandler: authenticate }, async (request) => {
    const result = await pool.query(
      'SELECT id, username, email, display_name, avatar_url, bio, status, custom_status FROM users WHERE id = ?',
      [request.user!.userId]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    return result.rows[0];
  });
};