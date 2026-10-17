import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger.js';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const clients = new Map();
const channelSubscriptions = new Map(); // channelId -> Set<userId>
export const wsHandler = async (app) => {
    app.get('/ws', { websocket: true }, (socket, request) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const token = url.searchParams.get('token');
        if (!token) {
            socket.close(4001, 'Missing token');
            return;
        }
        let payload;
        try {
            payload = jwt.verify(token, JWT_SECRET);
        }
        catch {
            socket.close(4002, 'Invalid token');
            return;
        }
        const userId = payload.sub;
        const client = { userId, socket };
        if (!clients.has(userId)) {
            clients.set(userId, new Set());
        }
        clients.get(userId).add(client);
        logger.info({ userId }, 'WebSocket connected');
        // Broadcast presence update
        broadcastPresence(userId, 'online');
        socket.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                handleWSMessage(userId, msg, socket);
            }
            catch (err) {
                logger.warn({ err, userId }, 'Invalid WS message');
            }
        });
        socket.on('close', () => {
            clients.get(userId)?.delete(client);
            // Remove from all channel subscriptions
            channelSubscriptions.forEach((users, channelId) => {
                users.delete(userId);
                if (users.size === 0)
                    channelSubscriptions.delete(channelId);
            });
            if (clients.get(userId)?.size === 0) {
                clients.delete(userId);
                broadcastPresence(userId, 'offline');
            }
            logger.info({ userId }, 'WebSocket disconnected');
        });
        socket.send(JSON.stringify({ type: 'connected', userId }));
    });
};
function handleWSMessage(userId, msg, socket) {
    switch (msg.type) {
        case 'ping':
            socket.send(JSON.stringify({ type: 'pong', t: Date.now() }));
            break;
        case 'subscribe_channel':
            if (msg.channelId) {
                if (!channelSubscriptions.has(msg.channelId)) {
                    channelSubscriptions.set(msg.channelId, new Set());
                }
                channelSubscriptions.get(msg.channelId).add(userId);
            }
            break;
        case 'unsubscribe_channel':
            if (msg.channelId) {
                channelSubscriptions.get(msg.channelId)?.delete(userId);
            }
            break;
        case 'typing':
            if (msg.channelId) {
                broadcastToChannel(msg.channelId, {
                    type: 'typing',
                    userId,
                    channelId: msg.channelId,
                }, userId);
            }
            break;
        default:
            logger.debug({ type: msg.type, userId }, 'Unhandled WS message type');
    }
}
function broadcastPresence(userId, status) {
    const data = JSON.stringify({ type: 'presence', userId, status });
    clients.forEach((userClients) => {
        userClients.forEach((client) => {
            try {
                client.socket.send(data);
            }
            catch {
                // ignore
            }
        });
    });
}
export function sendToUser(userId, data) {
    const userClients = clients.get(userId);
    if (!userClients)
        return;
    const payload = JSON.stringify(data);
    for (const client of userClients) {
        try {
            client.socket.send(payload);
        }
        catch {
            // client disconnected
        }
    }
}
export function broadcastToChannel(channelId, data, excludeUserId) {
    const subscribers = channelSubscriptions.get(channelId);
    if (!subscribers)
        return;
    const payload = JSON.stringify(data);
    for (const userId of subscribers) {
        if (userId === excludeUserId)
            continue;
        const userClients = clients.get(userId);
        if (!userClients)
            continue;
        for (const client of userClients) {
            try {
                client.socket.send(payload);
            }
            catch {
                // ignore
            }
        }
    }
}
//# sourceMappingURL=handler.js.map