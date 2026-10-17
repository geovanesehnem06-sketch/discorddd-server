import jwt from 'jsonwebtoken';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
export function signAccessToken(userId, email) {
    const options = { expiresIn: '15m' };
    return jwt.sign({ sub: userId, email }, JWT_SECRET, options);
}
export function signRefreshToken(userId) {
    const options = { expiresIn: JWT_EXPIRES_IN };
    return jwt.sign({ sub: userId, type: 'refresh' }, JWT_SECRET, options);
}
export async function authenticate(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }
    const token = authHeader.substring(7);
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        request.user = { userId: payload.sub, email: payload.email };
    }
    catch (err) {
        return reply.status(401).send({ error: 'Invalid or expired token' });
    }
}
//# sourceMappingURL=auth.js.map