import type { FastifyReply } from 'fastify';
import type { FastifyRequest } from 'fastify/types/request.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type {} from '@fastify/secure-session';

export interface AdminSession {
  userId: string;
  role: 'admin';
  loginTime: number;
  lastActivity: number;
}

export function validateSession(
  session: AdminSession | null | undefined,
  maxAgeSeconds: number
): session is AdminSession {
  if (!session) {
    return false;
  }

  const now = Date.now();
  const maxAgeMs = maxAgeSeconds * 1000;

  if (now - session.loginTime > maxAgeMs) {
    return false;
  }

  session.lastActivity = now;

  return true;
}

export async function sessionAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = request.session.get('admin') as AdminSession | undefined;
  const maxAge = Number(process.env['SESSION_MAX_AGE'] || 28800);

  if (!validateSession(session, maxAge)) {
    // Session invalid or expired
    // reply.send() terminates the request; return ensures no further middleware executes
    if (session) {
      request.session.delete();
    }
    reply.status(401).send({ error: 'Authentication required' });
    return;
  }

  request.user = {
    userId: session.userId,
    role: session.role,
  };
}
