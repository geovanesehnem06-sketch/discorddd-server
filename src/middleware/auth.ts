import { FastifyRequest, FastifyReply } from 'fastify';
import jwt, { SignOptions } from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { userId: string; email: string };
  }
}

export function signAccessToken(userId: string, email: string): string {
  const options: SignOptions = { expiresIn: '15m' };
  return jwt.sign({ sub: userId, email }, JWT_SECRET, options) as string;
}

export function signRefreshToken(userId: string): string {
  const options: SignOptions = { expiresIn: JWT_EXPIRES_IN as any };
  return jwt.sign({ sub: userId, type: 'refresh' }, JWT_SECRET, options) as string;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string };
    request.user = { userId: payload.sub, email: payload.email };
  } catch (err) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}