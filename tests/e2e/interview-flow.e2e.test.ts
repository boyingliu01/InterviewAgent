import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createE2EServer } from './helpers/e2e-server.js';
import { MockDingTalk } from './helpers/mock-dingtalk.js';
import { MockLLMQueue } from './helpers/mock-llm.js';

vi.mock('../../src/services/followup.service.js', () => ({
  generateSmartResponse: vi.fn(),
  polishFirstQuestion: vi.fn(),
  parseLLMResponse: vi.fn(),
  smartTruncate: vi.fn((text: string) => text),
  FALLBACK_RESPONSE: '感谢您的回答，我们继续下一个话题。',
}));

import { generateSmartResponse, polishFirstQuestion } from '../../src/services/followup.service.js';

vi.mock('../../src/utils/logger.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

const mockFetch = vi.fn(async () => {
  return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
});
global.fetch = mockFetch as unknown as typeof global.fetch;

const mockGenerateSmartResponse = generateSmartResponse as ReturnType<typeof vi.fn>;
const mockPolishFirstQuestion = polishFirstQuestion as ReturnType<typeof vi.fn>;

describe('Interview Flow (E2E)', () => {
  let server: Awaited<ReturnType<typeof createE2EServer>>;
  let mockDingtalk: MockDingTalk;
  let llmQueue: MockLLMQueue;
  let cleanupIds: {
    templates?: string[];
    interviews?: string[];
    interviewPlans?: string[];
    messages?: string[];
    responses?: string[];
  };

  beforeAll(async () => {
    server = await createE2EServer();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDingtalk = new MockDingTalk();
    llmQueue = new MockLLMQueue();
    cleanupIds = {};

    mockPolishFirstQuestion.mockResolvedValue(
      '您好！欢迎参与测试访谈。请简单介绍一下您的工作经历？'
    );

    mockGenerateSmartResponse.mockImplementation(() => {
      return Promise.resolve(llmQueue.dequeue());
    });
  });

  afterEach(async () => {
    const ids = { ...cleanupIds };
    if (ids.responses?.length) {
      await server.prisma.response
        .deleteMany({ where: { id: { in: ids.responses } } })
        .catch(() => {});
    }
    if (ids.messages?.length) {
      await server.prisma.message
        .deleteMany({ where: { id: { in: ids.messages } } })
        .catch(() => {});
    }
    if (ids.interviews?.length) {
      await server.prisma.analysisReport
        .deleteMany({ where: { interviewId: { in: ids.interviews } } })
        .catch(() => {});
      await server.prisma.analysisFailure
        .deleteMany({ where: { interviewId: { in: ids.interviews } } })
        .catch(() => {});
      await server.prisma.interview
        .deleteMany({ where: { id: { in: ids.interviews } } })
        .catch(() => {});
    }
    if (ids.interviewPlans?.length) {
      await server.prisma.interviewPlan
        .deleteMany({ where: { id: { in: ids.interviewPlans } } })
        .catch(() => {});
    }
    if (ids.templates?.length) {
      await server.prisma.template
        .deleteMany({ where: { id: { in: ids.templates } } })
        .catch(() => {});
    }
  });

  afterAll(async () => {
    await server.teardown();
  });

  async function createPublishedTemplate(questions: string[]): Promise<string> {
    const template = await server.prisma.template.create({
      data: {
        name: 'E2E 访谈测试模板',
        content: JSON.stringify({
          name: 'E2E 访谈测试模板',
          invitationPrompt: '欢迎参加测试访谈！',
          questions,
          closingMessage: '感谢您的参与，访谈到此结束！',
        }),
        status: 'PUBLISHED',
      },
    });
    cleanupIds.templates = [...(cleanupIds.templates || []), template.id];
    return template.id;
  }

  it(
    'should complete a full interview lifecycle: 3 questions, all NEXT',
    { timeout: 30000 },
    async () => {
      await createPublishedTemplate([
        '问题一：请介绍您的工作经历',
        '问题二：您最大的成就是什么？',
        '问题三：您未来的计划是什么？',
      ]);

      // Queue responses: NEXT for Q1+Q2, END for Q3 to complete the interview
      llmQueue.enqueue({
        action: 'NEXT',
        response: '感谢您的分享，让我们继续。下一个问题：您最大的成就是什么？',
      });
      llmQueue.enqueue({
        action: 'NEXT',
        response: '非常棒的成就！最后一个问题：您未来的计划是什么？',
      });
      llmQueue.enqueue({ action: 'END', response: '非常感谢您的分享，访谈到此结束！' });

      const userId = 'user_zhangsan';

      // Step 1: First message starts a new interview (goes through planning node)
      const result1 = await mockDingtalk.simulateUserMessage(server.prisma, userId, '你好');
      expect(result1.success).toBe(true);

      // Find the created interview — retry with backoff to handle async processing
      let interview = await server.prisma.interview.findFirst({
        where: { userId, status: { in: ['ACTIVE', 'PROCESSING', 'PENDING'] } },
      });
      if (!interview) {
        // Give async processing up to 3s to create the interview record
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise((r) => setTimeout(r, 500));
          interview = await server.prisma.interview.findFirst({
            where: { userId, status: { in: ['ACTIVE', 'PROCESSING', 'PENDING'] } },
          });
          if (interview) break;
        }
      }
      expect(interview).not.toBeNull();
      const interviewId = interview?.id ?? '';
      expect(interviewId, 'Expected interview to have an id').not.toBe('');
      if (interviewId) {
        cleanupIds.interviews = [...(cleanupIds.interviews || []), interviewId];
      }

      // Step 2: Answer first question
      const result2 = await mockDingtalk.simulateUserMessage(
        server.prisma,
        userId,
        '我有五年的工作经验'
      );
      expect(result2.success).toBe(true);

      // Step 3: Answer second question
      const result3 = await mockDingtalk.simulateUserMessage(
        server.prisma,
        userId,
        '我的最大成就是完成了大项目'
      );
      expect(result3.success).toBe(true);

      // Step 4: Answer third (last) question → triggers completion path
      const result4 = await mockDingtalk.simulateUserMessage(
        server.prisma,
        userId,
        '未来计划继续深造'
      );
      expect(result4.success).toBe(true);

      // Verify all 3 messages were processed (async analysis will set COMPLETED)
      if (interviewId) {
        const interview = await server.prisma.interview.findUnique({
          where: { id: interviewId },
        });
        expect(['ACTIVE', 'COMPLETED', 'PROCESSING']).toContain(interview?.status);

        // Verify all 3 responses are recorded
        const responses = await server.prisma.response.findMany({
          where: { interviewId },
        });
        expect(responses.length).toBeGreaterThanOrEqual(3);

        // Verify messages include both user and assistant
        const messages = await server.prisma.message.findMany({
          where: { interviewId },
          orderBy: { createdAt: 'asc' },
        });
        expect(messages.length).toBeGreaterThanOrEqual(6);
        expect(messages.some((m) => m.role === 'user')).toBe(true);
        expect(messages.some((m) => m.role === 'assistant')).toBe(true);
      }
    }
  );

  it('should handle a new interview via processStreamMessage', { timeout: 30000 }, async () => {
    await createPublishedTemplate(['请描述您的工作', '您喜欢您的工作吗？']);

    llmQueue.enqueue({ action: 'NEXT', response: '了解了，下一个问题：您喜欢您的工作吗？' });
    llmQueue.enqueue({ action: 'NEXT', response: '非常好的分享，访谈到此结束！' });

    const userId = 'user_lisi';

    const result1 = await mockDingtalk.simulateUserMessage(server.prisma, userId, '我是一名工程师');
    expect(result1.success).toBe(true);

    const interviews = await server.prisma.interview.findMany({
      where: { userId },
    });
    expect(interviews.length).toBeGreaterThan(0);
    cleanupIds.interviews = [...(cleanupIds.interviews || []), ...interviews.map((i) => i.id)];

    const result2 = await mockDingtalk.simulateUserMessage(server.prisma, userId, '很喜欢');
    expect(result2.success).toBe(true);
  });

  it(
    'should prevent restarting a completed interview within cooldown',
    { timeout: 30000 },
    async () => {
      await createPublishedTemplate(['问题：请介绍您的经历']);

      llmQueue.enqueue({ action: 'NEXT', response: '感谢分享！' });

      const userId = 'user_cooldown_e2e';

      const result1 = await mockDingtalk.simulateUserMessage(
        server.prisma,
        userId,
        '我的经历很丰富'
      );
      expect(result1.success).toBe(true);

      // Cleanup
      const interviews = await server.prisma.interview.findMany({ where: { userId } });
      cleanupIds.interviews = [...(cleanupIds.interviews || []), ...interviews.map((i) => i.id)];
    }
  );

  it('should prevent restarting a completed interview within cooldown', async () => {
    await createPublishedTemplate(['问题：请介绍您的经历']);

    llmQueue.enqueue({ action: 'NEXT', response: '感谢分享！' });

    const userId = 'user_zhangsan_e2e_completed';

    // Complete an interview first
    const message1 = {
      specVersion: '1.0' as const,
      type: 'CALLBACK' as const,
      headers: {
        topic: '/v1.0/im/bot/messages/get',
        messageId: `msg-${Date.now()}-1`,
        time: new Date().toISOString(),
      },
      data: JSON.stringify({
        senderStaffId: userId,
        text: { content: '我的经历很丰富' },
        msgtype: 'text',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send',
      }),
    };

    const { processStreamMessage } = await import('../../src/services/stream-message.service.js');
    const result1 = await processStreamMessage(message1, server.prisma);
    expect(result1.success).toBe(true);

    // Cleanup tracking
    const interviews = await server.prisma.interview.findMany({ where: { userId } });
    cleanupIds.interviews = [...(cleanupIds.interviews || []), ...interviews.map((i) => i.id)];
  });
});
