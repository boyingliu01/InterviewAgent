import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AdminSession, sessionAuth, validateSession } from '../src/middleware/session-auth.js';

describe('validateSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return true for valid session within timeout', () => {
    const session: AdminSession = {
      userId: 'admin',
      role: 'admin',
      loginTime: Date.now(),
      lastActivity: Date.now(),
    };

    const result = validateSession(session, 28800);

    expect(result).toBe(true);
  });

  it('should return false for expired session', () => {
    const session: AdminSession = {
      userId: 'admin',
      role: 'admin',
      loginTime: Date.now() - 28801 * 1000,
      lastActivity: Date.now() - 28801 * 1000,
    };

    const result = validateSession(session, 28800);

    expect(result).toBe(false);
  });

  it('should update lastActivity for valid session', () => {
    const session: AdminSession = {
      userId: 'admin',
      role: 'admin',
      loginTime: Date.now() - 3600 * 1000,
      lastActivity: Date.now() - 3600 * 1000,
    };

    const oldLastActivity = session.lastActivity;
    vi.advanceTimersByTime(1000);

    const result = validateSession(session, 28800);

    expect(result).toBe(true);
    expect(session.lastActivity).toBeGreaterThan(oldLastActivity);
  });

  it('should return false for null session', () => {
    const result = validateSession(null, 28800);
    expect(result).toBe(false);
  });

  it('should return false for undefined session', () => {
    const result = validateSession(undefined, 28800);
    expect(result).toBe(false);
  });
});

describe('sessionAuth', () => {
  let mockSessionGet: ReturnType<typeof vi.fn>;
  let mockSessionDelete: ReturnType<typeof vi.fn>;
  let mockReplySend: ReturnType<typeof vi.fn>;
  let mockReplyStatus: ReturnType<typeof vi.fn>;

  function createRequest(sessionData: AdminSession | undefined) {
    mockSessionGet = vi.fn().mockReturnValue(sessionData);
    mockSessionDelete = vi.fn();
    return {
      session: {
        get: mockSessionGet,
        delete: mockSessionDelete,
      },
    } as unknown as Parameters<typeof sessionAuth>[0];
  }

  function createReply() {
    mockReplySend = vi.fn();
    mockReplyStatus = vi.fn().mockReturnValue({ send: mockReplySend });
    return { status: mockReplyStatus } as unknown as Parameters<typeof sessionAuth>[1];
  }

  beforeEach(() => {
    vi.stubEnv('SESSION_MAX_AGE', '28800');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should attach user for valid session', async () => {
    const session: AdminSession = {
      userId: 'admin',
      role: 'admin',
      loginTime: Date.now(),
      lastActivity: Date.now(),
    };
    const request = createRequest(session);
    const reply = createReply();

    await sessionAuth(request, reply);

    expect(request.user).toEqual({ userId: 'admin', role: 'admin' });
  });

  it('should return 401 for invalid session', async () => {
    const request = createRequest(undefined);
    const reply = createReply();

    await sessionAuth(request, reply);

    expect(mockReplyStatus).toHaveBeenCalledWith(401);
    expect(mockReplySend).toHaveBeenCalled();
  });

  it('should delete expired session', async () => {
    const session: AdminSession = {
      userId: 'admin',
      role: 'admin',
      loginTime: Date.now() - 28801 * 1000,
      lastActivity: Date.now() - 28801 * 1000,
    };
    const request = createRequest(session);
    const reply = createReply();

    await sessionAuth(request, reply);

    expect(mockSessionDelete).toHaveBeenCalled();
    expect(mockReplyStatus).toHaveBeenCalledWith(401);
  });

  it('should use default 28800 when SESSION_MAX_AGE is not set', async () => {
    vi.unstubAllEnvs();
    const session: AdminSession = {
      userId: 'admin',
      role: 'admin',
      loginTime: Date.now(),
      lastActivity: Date.now(),
    };
    const request = createRequest(session);
    const reply = createReply();

    await sessionAuth(request, reply);

    expect(request.user).toEqual({ userId: 'admin', role: 'admin' });
  });
});
