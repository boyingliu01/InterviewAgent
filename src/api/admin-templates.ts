import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { adminAuth } from '../middleware/admin-auth.js';
import type { InterviewRepository } from '../repositories/interview.repository.js';
import type { TemplateRepository } from '../repositories/template.repository.js';
import type { AnalysisService } from '../services/analysis.service.js';
import type { AnalyticsService } from '../services/analytics.service.js';
import type { ExportService } from '../services/export.service.js';
import type { InterviewPlanService } from '../services/interview-plan.service.js';
import { updateTemplateDimensions } from '../services/template-dimension.service.js';
import { error, info } from '../utils/logger.js';

export interface AdminTemplatesRoutesOptions {
  templateRepo: TemplateRepository;
  interviewPlanService: InterviewPlanService;
  interviewRepo: InterviewRepository;
  analysisService: AnalysisService;
  analyticsService: AnalyticsService;
  exportService?: ExportService;
  prisma: PrismaClient;
}

const createTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().or(z.undefined()),
  content: z.object({}).passthrough(),
});
const updateTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().or(z.undefined()),
  content: z.object({}).passthrough(),
});
const versionSchema = z.object({ version: z.coerce.number().int().positive() });

function extractStructuredQuestions(questionsObj: Record<string, { text: string }>): string[] {
  const questions: string[] = [];
  for (const key of Object.keys(questionsObj).sort()) {
    const q = questionsObj[key];
    if (q && typeof q === 'object' && typeof q.text === 'string') {
      const trimmed = q.text.trim();
      if (trimmed) questions.push(trimmed);
    }
  }
  return questions;
}

function extractFlatFormQuestions(body: Record<string, unknown>): string[] {
  const questions: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const match = key.match(/^questions\[(\d+)\]\[text\]$/);
    if (match && typeof value === 'string') {
      const index = Number.parseInt(match[1], 10);
      const trimmed = value.trim();
      if (trimmed) {
        questions[index] = trimmed;
      }
    }
  }
  return questions.filter((q): q is string => q !== undefined);
}

function buildDefaultContent(body: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {
    invitationPrompt: String(body['invitationPrompt'] || ''),
    questions: [],
  };

  if (body['closingMessage']) content['closingMessage'] = body['closingMessage'];
  if (body['llmPromptTemplate']) content['llmPromptTemplate'] = body['llmPromptTemplate'];

  const questionsObj = body['questions'] as Record<string, { text: string }> | undefined;
  if (questionsObj && typeof questionsObj === 'object') {
    content['questions'] = extractStructuredQuestions(questionsObj);
  } else {
    content['questions'] = extractFlatFormQuestions(body);
  }

  return content;
}

function buildContentFromForm(body: Record<string, unknown>): Record<string, unknown> {
  if (body['content'] && typeof body['content'] === 'object' && !Array.isArray(body['content'])) {
    return body['content'] as Record<string, unknown>;
  }
  return buildDefaultContent(body);
}

function validateTemplateContent(content: Record<string, unknown>): string | null {
  const questions = content['questions'] as string[] | undefined;
  if (!questions || questions.length === 0) {
    return '请至少添加一个问题';
  }
  const invitationPrompt = content['invitationPrompt'] as string | undefined;
  if (!invitationPrompt || !invitationPrompt.trim()) {
    return '请填写邀约提示词';
  }
  return null;
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function htmlError(message: string): string {
  return `<div class="text-red-600">${htmlEscape(message)}</div>`;
}
function fmtDate(d: Date | null | undefined): string {
  return d?.toLocaleString('zh-CN') ?? '-';
}

function buildInviteeNameMap(inviteeData: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(inviteeData)) return map;
  for (const entry of inviteeData) {
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const userId = typeof obj['userId'] === 'string' ? obj['userId'] : undefined;
      const name = typeof obj['name'] === 'string' ? obj['name'] : undefined;
      if (userId && name) {
        map[userId] = name;
      }
    }
  }
  return map;
}

function findInviteeInfo(inviteeData: unknown, userId: string): { name?: string; phone?: string } {
  if (!Array.isArray(inviteeData)) return {};
  for (const entry of inviteeData) {
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      if (obj['userId'] === userId) {
        const result: { name?: string; phone?: string } = {};
        if (typeof obj['name'] === 'string') result.name = obj['name'];
        if (typeof obj['phone'] === 'string') result.phone = obj['phone'];
        return result;
      }
    }
  }
  return {};
}

function buildQuestionMapFromTemplate(
  contentJson: string | null | undefined
): Record<string, string> {
  if (!contentJson) return {};
  try {
    const parsed = JSON.parse(contentJson) as { questions?: string[] };
    const questions = parsed.questions || [];
    const map: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      map[`q${i}`] = questions[i];
    }
    return map;
  } catch {
    return {};
  }
}

export async function adminTemplatesRoutes(
  fastify: FastifyInstance,
  opts: AdminTemplatesRoutesOptions
) {
  const {
    templateRepo,
    interviewPlanService,
    interviewRepo,
    analysisService,
    analyticsService,
    exportService,
    prisma,
  } = opts;
  const BASE_PATH = '/admin';
  const API_PATH = '/admin/api';

  // GET /admin — Tree view main entry (new hierarchical UI)
  fastify.get(
    '/admin',
    { preHandler: adminAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const templates = await templateRepo.findAllForAdminTree();
        const templatesWithPlans = templates.map((t) => ({
          ...t,
          _plans: t.interviewPlans.map((p) => ({
            ...p,
            _interviews: p.interviews,
            _interviewCount: p._count.interviews,
            _completedCount: p.interviews.filter((i) => i.status === 'COMPLETED').length,
          })),
          _planCount: t._count.interviewPlans,
          _interviewCount: t._count.interviews,
          interviewPlans: undefined,
        }));
        return reply.view('layouts/admin-tree.njk', {
          templates: templatesWithPlans,
          adminUser: _request.user ? _request.user['userId'] : undefined,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to load admin tree';
        error('Failed to load admin tree', { error: errMsg });
        return reply.status(500).view('error.njk', { message: errMsg });
      }
    }
  );

  // GET /admin/content/dashboard — Plan Progress Dashboard (HTMX fragment)
  fastify.get(
    `${BASE_PATH}/content/dashboard`,
    { preHandler: adminAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const plans = await analyticsService.getDashboardPlanProgress();
        return reply.view('admin/content/dashboard.njk', {
          plans,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to load dashboard';
        error('Failed to load dashboard', { error: errMsg });
        return reply.status(500).send(`<div class="text-red-600">${htmlEscape(errMsg)}</div>`);
      }
    }
  );

  fastify.get(
    '/admin/content/templates/new',
    { preHandler: adminAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.view('admin/content/template-new.njk', {});
    }
  );

  // GET /admin/content/templates/import — HTMX fragment for JSON import form
  fastify.get(
    '/admin/content/templates/import',
    { preHandler: adminAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.view('admin/content/template-import.njk', {});
    }
  );

  // GET /admin/content/plans/new — HTMX fragment for new plan form
  fastify.post(
    `${API_PATH}/templates/import`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as Record<string, unknown>;
        const jsonStr = body['json'] as string | undefined;
        if (!jsonStr || !jsonStr.trim()) {
          return reply.status(422).send(htmlError('请粘贴模板 JSON 内容'));
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          return reply.status(422).send(htmlError('JSON 格式错误，请检查后重试'));
        }

        const name = parsed['name'] as string | undefined;
        const description = parsed['description'] as string | undefined;
        const content = parsed['content'] as Record<string, unknown> | undefined;
        const dimensions = parsed['dimensions'] as
          | Array<{ id: string; label: string; keywords?: string[] }>
          | undefined;

        if (!name || !name.trim()) {
          return reply.status(422).send(htmlError('JSON 缺少 name 字段'));
        }
        if (!content || typeof content !== 'object') {
          return reply.status(422).send(htmlError('JSON 缺少 content 字段'));
        }

        const validationError = validateTemplateContent(content);
        if (validationError) return reply.status(422).send(htmlError(validationError));

        const created = await templateRepo.create({
          name: name.trim(),
          ...(description != null ? { description: description.trim() } : {}),
          content,
        });

        // Save dimensions to the DB-level column if provided
        if (dimensions && Array.isArray(dimensions) && dimensions.length > 0) {
          try {
            await updateTemplateDimensions(prisma, created.id, dimensions);
          } catch (e) {
            const dimErr = e instanceof Error ? e.message : 'Invalid dimensions';
            error('Template created but dimensions import failed', {
              templateId: created.id,
              error: dimErr,
            });
            // Non-fatal: template was created, just dimensions failed
          }
        }

        info('Admin template imported', { name: name.trim() });
        return reply.status(201).header('HX-Redirect', '/admin').send('');
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to import template';
        error('Failed to import admin template', { error: errMsg });
        return reply.status(500).send(htmlError(errMsg));
      }
    }
  );

  fastify.get(
    '/admin/content/plans/new',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { templateId } = (request.query as Record<string, string | undefined>) || {};
      const templates = await templateRepo.findAllForSelect();
      return reply.view('admin/content/plan-form.njk', {
        templates,
        selectedTemplateId: templateId || null,
      });
    }
  );

  // GET /admin/content/plans/:id/edit — HTMX fragment for edit plan form
  fastify.get(
    '/admin/content/plans/:id/edit',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const plan = await interviewPlanService.findByIdWithTemplate(id);
      if (!plan) return reply.status(404).type('text/html').send('计划不存在');
      const templates = await templateRepo.findAllForSelect();
      return reply.view('admin/content/plan-form.njk', {
        templates,
        plan,
        selectedTemplateId: plan.templateId,
        isEdit: true,
      });
    }
  );

  // GET /admin/content/templates/:id
  fastify.get(
    '/admin/content/templates/:id',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const template = await templateRepo.findByIdWithCounts(id);
      if (!template) return reply.status(404).type('text/html').send('模板不存在');
      let parsedContent: Record<string, unknown>;
      try {
        parsedContent = JSON.parse(template.content) as Record<string, unknown>;
      } catch {
        parsedContent = {};
      }
      const questions = (parsedContent['questions'] as string[]) || [];
      const tpl = {
        ...template,
        _planCount: template._count.interviewPlans,
        _interviewCount: template._count.interviews,
      };
      return reply.view('admin/content/template-info.njk', {
        template: tpl,
        questions,
        invitationPrompt: parsedContent['invitationPrompt'] as string | undefined,
        closingMessage: parsedContent['closingMessage'] as string | undefined,
      });
    }
  );

  // GET /admin/content/plans/:id
  fastify.get(
    '/admin/content/plans/:id',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const plan = await interviewPlanService.findByIdWithInterviewsAndCounts(id);
      if (!plan) return reply.status(404).type('text/html').send('计划不存在');
      const completed = plan.interviews.filter((i) => i.status === 'COMPLETED');
      let planStats = null;
      try {
        planStats = await analyticsService.getPlanStats(id);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to compute plan stats';
        error('Failed to load plan stats for plan-detail render', { planId: id, error: errMsg });
      }
      const inviteeMap = buildInviteeNameMap(plan.inviteeData);
      return reply.view('admin/content/plan-detail.njk', {
        plan,
        template: plan.template,
        interviews: plan.interviews,
        totalInterviews: plan._count.interviews,
        completedCount: completed.length,
        completionRate:
          plan.sentCount > 0 ? Math.round((completed.length / plan.sentCount) * 100) : 0,
        planStats,
        inviteeMap,
      });
    }
  );

  // GET /admin/content/plans/:id/all-interviews
  fastify.get(
    '/admin/content/plans/:id/all-interviews',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const interviews = await interviewRepo.findByPlanId(id);
      const plan = await interviewPlanService.findByIdWithTemplate(id);
      if (!plan) return reply.status(404).type('text/html').send('计划不存在');
      const completed = interviews.filter((i) => i.status === 'COMPLETED');
      return reply.view('admin/content/plan-detail.njk', {
        plan: { ...plan, sentCount: 0 },
        template: plan.template,
        interviews,
        totalInterviews: interviews.length,
        completedCount: completed.length,
        completionRate: 0,
      });
    }
  );

  // GET /admin/content/reports/:interviewId
  fastify.get(
    '/admin/content/reports/:interviewId',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { interviewId } = request.params as { interviewId: string };
      const interview = await prisma.interview.findUnique({
        where: { id: interviewId },
        select: {
          id: true,
          userId: true,
          status: true,
          planId: true,
          createdAt: true,
          completedAt: true,
          template: { select: { content: true } },
          messages: {
            select: { role: true, content: true },
            orderBy: { createdAt: 'asc' },
          },
          responses: {
            select: { questionId: true, content: true, isFollowup: true, followupDepth: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!interview) return reply.status(404).type('text/html').send('访谈不存在');
      const report = await analysisService.getReportByInterviewId(interviewId);

      const questionMap = buildQuestionMapFromTemplate(interview.template?.content);

      let inviteeInfo: { name?: string; phone?: string } = {};
      if (interview.planId) {
        const plan = await prisma.interviewPlan.findUnique({
          where: { id: interview.planId },
          select: { inviteeData: true },
        });
        inviteeInfo = findInviteeInfo(plan?.inviteeData, interview.userId);
      }

      return reply.view('admin/content/report-detail.njk', {
        interview,
        report,
        inviteeInfo,
        questionMap,
      });
    }
  );

  // GET /admin/api/reports/:interviewId/download - download report as Markdown file
  fastify.get(
    '/admin/api/reports/:interviewId/download',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { interviewId } = request.params as { interviewId: string };
      const interview = await prisma.interview.findUnique({
        where: { id: interviewId },
        select: {
          id: true,
          userId: true,
          status: true,
          planId: true,
          messages: {
            select: { role: true, content: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!interview) {
        return reply.status(404).type('text/plain').send('Interview not found');
      }

      const report = await analysisService.getReportByInterviewId(interviewId);

      let inviteeInfo: { name?: string; phone?: string } = {};
      if (interview.planId) {
        const plan = await prisma.interviewPlan.findUnique({
          where: { id: interview.planId },
          select: { inviteeData: true },
        });
        inviteeInfo = findInviteeInfo(plan?.inviteeData, interview.userId);
      }

      const lines: string[] = [];
      lines.push('# 访谈报告');
      lines.push('');
      lines.push(`- **用户**: ${interview.userId}`);
      if (inviteeInfo.name) lines.push(`- **姓名**: ${inviteeInfo.name}`);
      if (inviteeInfo.phone) lines.push(`- **电话**: ${inviteeInfo.phone}`);
      lines.push(`- **状态**: ${interview.status}`);
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push('## 访谈对话记录');
      lines.push('');

      for (const m of interview.messages) {
        const roleLabel = m.role === 'assistant' ? '🤖 机器人' : '👤 受访者';
        lines.push(`**${roleLabel}**：`);
        lines.push('');
        lines.push(m.content);
        lines.push('');
      }

      if (report) {
        lines.push('---');
        lines.push('');
        lines.push('## 访谈分析总结');
        lines.push('');
        lines.push(report.content ?? '');
        lines.push('');
        if (report.sentiment) {
          const sentimentMap: Record<string, string> = {
            positive: '积极',
            negative: '消极',
            neutral: '中性',
          };
          lines.push(`**情感分析**: ${sentimentMap[report.sentiment] ?? report.sentiment}`);
          lines.push('');
        }
        if (report.keyFindings?.length) {
          lines.push('**关键发现**：');
          lines.push('');
          for (const f of report.keyFindings) {
            lines.push(`- ${f}`);
          }
          lines.push('');
        }
        if (report.recommendations?.length) {
          lines.push('**建议**：');
          lines.push('');
          for (const r of report.recommendations) {
            lines.push(`- ${r}`);
          }
          lines.push('');
        }
      }

      const markdown = lines.join('\n');
      const filename = `interview-report-${interviewId}.md`;
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(markdown);
    }
  );

  // GET /admin/api/reports/:interviewId/export/pdf — download report as PDF
  fastify.get(
    '/admin/api/reports/:interviewId/export/pdf',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { interviewId } = request.params as { interviewId: string };
      if (!exportService) {
        return reply.status(500).type('text/plain').send('PDF export not available');
      }
      try {
        const pdfPath = await exportService.exportInterviewToPdf(interviewId);
        const pdfBuffer = readFileSync(pdfPath);
        const filename = `interview-report-${interviewId}.pdf`;
        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(pdfBuffer);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'PDF export failed';
        error('PDF export failed', { interviewId, error: errMsg });
        return reply.status(500).type('text/plain').send(errMsg);
      }
    }
  );

  // GET /admin/api/reports/:interviewId/export/excel — download report as Excel
  fastify.get(
    '/admin/api/reports/:interviewId/export/excel',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { interviewId } = request.params as { interviewId: string };
      if (!exportService) {
        return reply.status(500).type('text/plain').send('Excel export not available');
      }
      try {
        const xlsxPath = await exportService.exportInterviewToExcel(interviewId);
        const xlsxBuffer = readFileSync(xlsxPath);
        const filename = `interview-report-${interviewId}.xlsx`;
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(xlsxBuffer);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Excel export failed';
        error('Excel export failed', { interviewId, error: errMsg });
        return reply.status(500).type('text/plain').send(errMsg);
      }
    }
  );

  // POST /admin/api/reports/:interviewId/reanalyze - regenerate analysis report
  fastify.post(
    '/admin/api/reports/:interviewId/reanalyze',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { interviewId } = request.params as { interviewId: string };
      try {
        const result = await analysisService.analyzeInterview(interviewId);
        return reply.send({
          success: true,
          interviewId: result.interviewId,
          sentiment: result.report.sentiment,
          keyFindingsCount: result.report.keyFindings.length,
          recommendationsCount: result.report.recommendations.length,
          usedLLM: result.report.usedLLM ?? false,
          contentLength: result.report.content.length,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Analysis failed';
        error('Reanalysis failed', { interviewId, error: errMsg });
        return reply.status(500).send({ error: errMsg });
      }
    }
  );

  fastify.get(
    `${BASE_PATH}/content/templates/:id/edit`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const template = await templateRepo.findById(id);
        if (!template)
          return reply.status(404).view('error.njk', { message: 'Template not found' });
        let parsedContent: Record<string, unknown>;
        try {
          parsedContent = JSON.parse(template.content) as Record<string, unknown>;
        } catch {
          parsedContent = {};
        }
        const questions = (parsedContent['questions'] as string[]) || [];
        return reply.view('admin/content/template-edit.njk', {
          isEdit: true,
          template: { ...template, ...parsedContent },
          existingQuestions: questions.map((q, i) => ({ text: q, order: i, uid: `uid_${i}` })),
          action: 'edit',
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to load template';
        error('Failed to load admin template edit form', { error: errMsg, templateId: id });
        return reply.status(500).view('error.njk', { message: errMsg });
      }
    }
  );

  // POST /admin/api/templates/:id/publish — Change template status to PUBLISHED
  fastify.post(
    `${API_PATH}/templates/:id/publish`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const existing = await templateRepo.findById(id);
        if (!existing) return reply.status(404).send(htmlError('模板不存在'));
        if (existing.status === 'PUBLISHED') return reply.send(htmlError('模板已发布'));
        await templateRepo.publish(id);
        info('Admin template published', { templateId: id });
        return reply
          .header('HX-Get', `/admin/content/templates/${id}`)
          .header('HX-Target', '#main-content')
          .send('<div class="text-green-600 text-sm mb-2">已发布</div>');
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to publish template';
        error('Failed to publish admin template', { error: errMsg, templateId: id });
        return reply.status(500).send(htmlError(errMsg));
      }
    }
  );

  fastify.post(
    `${API_PATH}/templates`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const rawBody = request.body as Record<string, unknown>;
        const content = buildContentFromForm(rawBody);
        const validationError = validateTemplateContent(content);
        if (validationError) return reply.status(422).send(htmlError(validationError));
        const input = createTemplateSchema.parse({
          name: rawBody['name'],
          description: rawBody['description'],
          content,
        });
        await templateRepo.create({
          name: input.name,
          ...(input.description != null ? { description: input.description } : {}),
          content: input.content as Record<string, unknown>,
        });
        info('Admin template created', { name: input.name });
        return reply.status(201).header('HX-Redirect', '/admin').send('');
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply.status(422).send(htmlError(e.issues[0]?.message ?? 'Validation failed'));
        const errMsg = e instanceof Error ? e.message : 'Failed to create template';
        error('Failed to create admin template', { error: errMsg });
        return reply.status(500).send(htmlError(errMsg));
      }
    }
  );

  fastify.put(
    `${API_PATH}/templates/:id`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const qp = request.query as Record<string, string | undefined>;
        const body = request.body as Record<string, unknown>;
        const versionRaw = (qp['version'] ?? body['version']) as string | number | undefined;
        const versionParsed = versionSchema.safeParse({ version: versionRaw });
        if (!versionParsed.success)
          return reply.status(422).send(htmlError('Version number is required'));
        const content = buildContentFromForm(body);
        const validationError = validateTemplateContent(content);
        if (validationError) return reply.status(422).send(htmlError(validationError));
        const input = updateTemplateSchema.parse({
          name: body['name'],
          description: body['description'],
          content,
        });
        await templateRepo.updateWithVersion(id, versionParsed.data.version, {
          name: input.name,
          ...(input.description != null ? { description: input.description } : {}),
          content: input.content as Record<string, unknown>,
        });
        info('Admin template updated', { templateId: id });
        return reply
          .status(200)
          .send('<div class="text-green-600 font-medium">✓ 保存成功，正在返回...</div>');
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply.status(422).send(htmlError(e.issues[0]?.message ?? 'Validation failed'));
        if (
          e instanceof Error &&
          (e.message.toLowerCase().includes('record') ||
            (e as unknown as { code?: string }).code === 'P2025')
        ) {
          return reply
            .status(409)
            .send('<div class="text-red-600">模板已被他人修改，请刷新后重试</div>');
        }
        if (e instanceof Error && e.message.includes('find'))
          return reply.status(404).send(htmlError('Template not found'));
        const errMsg = e instanceof Error ? e.message : 'Failed to update template';
        error('Failed to update admin template', { error: errMsg, templateId: id });
        return reply.status(500).send(htmlError(errMsg));
      }
    }
  );

  fastify.delete(
    `${API_PATH}/templates/:id`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const existing = await templateRepo.findById(id);
        if (!existing) return reply.status(404).send(htmlError('Template not found'));
        const usageStats = await templateRepo.getUsageStats(id);

        // Check Interview FK constraint
        const totalInterviews =
          usageStats.interviews.active +
          usageStats.interviews.pending +
          usageStats.interviews.waiting +
          usageStats.interviews.completed +
          usageStats.interviews.cancelled;

        if (totalInterviews > 0) {
          return reply
            .status(409)
            .send(
              `<div class="text-red-600">不能删除：该模板关联了 ${totalInterviews} 个访谈记录</div>`
            );
        }

        // Check InterviewPlan FK constraint
        const totalPlans =
          (usageStats.plans?.running ?? 0) +
          (usageStats.plans?.pending ?? 0) +
          (usageStats.plans?.ready ?? 0) +
          (usageStats.plans?.paused ?? 0) +
          (usageStats.plans?.completed ?? 0);

        if (totalPlans > 0) {
          return reply
            .status(409)
            .send(
              `<div class="text-red-600">不能删除：该模板关联了 ${totalPlans} 个访谈计划</div>`
            );
        }

        const verified = await templateRepo.deleteAndVerify(id);

        if (!verified) {
          error('Database delete failed: record still exists after delete call', {
            templateId: id,
          });
          return reply.status(500).send(htmlError('数据库删除失败，记录仍然存在'));
        }

        info('Admin template deleted and verified', { templateId: id });
        return reply.send(`
          <div class="text-green-600">模板已删除</div>
          <script>
            // Clear the modal container to close it
            setTimeout(() => {
              const modalContainer = document.getElementById('delete-modal-container');
              if (modalContainer) {
                modalContainer.innerHTML = '';
              }
              // Refresh page to update the tables since row removal is complex with outerHTML 
              location.reload();
            }, 500);
          </script>
        `);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to delete template';
        error('Failed to delete admin template', { error: errMsg, templateId: id });
        return reply.status(500).send(htmlError(errMsg));
      }
    }
  );

  fastify.get(
    `${API_PATH}/templates/:id/usage`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await templateRepo.getUsageStats((request.params as { id: string }).id);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed';
        return reply.status(500).send({ error: errMsg });
      }
    }
  );

  fastify.get(
    `${API_PATH}/templates`,
    { preHandler: adminAuth },
    async (_r: FastifyRequest, reply: FastifyReply) => {
      try {
        const qp = (_r.query as Record<string, string | undefined>)['page'];
        const page = qp ? Math.max(1, Number.parseInt(qp, 10)) : 1;
        const result = await templateRepo.findAllPaginated(page, 20);
        const rows = result.items
          .map(
            (t) =>
              `<tr><td>${htmlEscape(t.id)}</td><td>${htmlEscape(t.name)}</td><td>${t.status}</td><td>v${t.version}</td></tr>`
          )
          .join('\n');
        return reply.type('text/html').send(rows);
      } catch (e) {
        return reply.status(500).send(htmlError(e instanceof Error ? e.message : 'Failed'));
      }
    }
  );

  // GET /admin/api/templates/:id/stats - Usage statistics JSON
  fastify.get(
    `${API_PATH}/templates/:id/stats`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const interviewStats = await interviewRepo.countByStatusForTemplate(id);
        const planStats = await interviewPlanService.countByStatusForTemplate(id);
        return reply.send({
          interviews: interviewStats.counts,
          plans: planStats.counts,
          totalInterviews: interviewStats.total,
          totalPlans: planStats.total,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed';
        return reply.status(500).send({ error: errMsg });
      }
    }
  );

  fastify.delete(
    `${API_PATH}/plans/:id`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { force?: string };
      try {
        const plan = await interviewPlanService.findByIdWithDeleteChecks(id);

        if (!plan) return reply.status(404).type('text/html').send('计划不存在');

        const hasInterviews = plan._count.interviews > 0;
        const hasBatchReports = plan._count.batchReports > 0;

        if (query.force === 'true') {
          const result = await interviewPlanService.deletePlanWithInterviews(id);
          return reply.send(
            `<div class="text-green-600">计划「${result.planName}」已删除，同时删除 ${result.interviewCount} 条访谈记录和 ${result.batchReportCount} 个批量报告</div>`
          );
        }

        if (hasInterviews || hasBatchReports) {
          const parts = [];
          if (hasInterviews) parts.push(`${plan._count.interviews} 个访谈记录`);
          if (hasBatchReports) parts.push(`${plan._count.batchReports} 个批量报告`);
          return reply
            .status(409)
            .send(
              `<div class="text-red-600" data-delete-warning="true" data-count-interviews="${plan._count.interviews}" data-count-reports="${plan._count.batchReports}">该计划关联了 ${parts.join('、')}，删除将一并删除这些数据</div>`
            );
        }

        await interviewPlanService.deletePlan(id);
        info('Admin plan deleted', { planId: id });
        return reply.send('<div class="text-green-600">计划已删除</div>');
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to delete plan';
        error('Failed to delete admin plan', { error: errMsg, planId: id });
        return reply.status(500).send(htmlError(errMsg));
      }
    }
  );

  // GET /admin/analytics - Analytics dashboard
  fastify.get(
    `${BASE_PATH}/analytics`,
    { preHandler: adminAuth },
    async (_r: FastifyRequest, reply: FastifyReply) => {
      try {
        const [kpis, statusDistribution, planCompletionRates, weeklyTrend, templates, plans] =
          await Promise.all([
            analyticsService.getKPIs(),
            analyticsService.getStatusDistribution(),
            analyticsService.getPlanCompletionRates(),
            analyticsService.getWeeklyTrend(),
            templateRepo.findAllForSelect(),
            interviewPlanService.findAllForSelect(),
          ]);
        return reply.view('analytics/index.njk', {
          kpis,
          statusDistribution,
          planCompletionRates,
          weeklyTrend,
          templates,
          plans,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to load analytics';
        error('Failed to load analytics', { error: errMsg });
        return reply.status(500).view('error.njk', { message: errMsg });
      }
    }
  );

  // GET /api/admin/analytics/data - Analytics data API
  fastify.get(
    `${API_PATH}/analytics/data`,
    { preHandler: adminAuth },
    async (_r: FastifyRequest, reply: FastifyReply) => {
      try {
        const [kpis, statusDistribution, planCompletionRates, weeklyTrend] = await Promise.all([
          analyticsService.getKPIs(),
          analyticsService.getStatusDistribution(),
          analyticsService.getPlanCompletionRates(),
          analyticsService.getWeeklyTrend(),
        ]);
        return reply.send({
          success: true,
          data: { kpis, statusDistribution, planCompletionRates, weeklyTrend },
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to fetch analytics data';
        error('Failed to fetch analytics data', { error: errMsg });
        return reply.status(500).send({ success: false, error: errMsg });
      }
    }
  );

  fastify.get(
    `${BASE_PATH}/reports`,
    { preHandler: adminAuth },
    async (_r: FastifyRequest, reply: FastifyReply) => {
      try {
        const reports = await analysisService.findRecentReports(100);
        return reply.view('reports/index.njk', {
          reports: reports.map((r) => ({
            interviewId: r.interviewId,
            userId: r.interview?.userId ?? '-',
            status: r.interview?.status ?? '-',
            sentiment: r.sentiment ?? '',
            createdAtFormatted: fmtDate(r.createdAt),
          })),
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to load reports';
        error('Failed to load admin reports', { error: errMsg });
        return reply.status(500).view('error.njk', { message: errMsg });
      }
    }
  );

  fastify.get(
    `${BASE_PATH}/reports/:interviewId`,
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { interviewId } = request.params as { interviewId: string };
      try {
        const report = await analysisService.getReportByInterviewId(interviewId);
        const interviewData = await prisma.interview.findUnique({
          where: { id: interviewId },
          select: {
            id: true,
            userId: true,
            status: true,
            planId: true,
            createdAt: true,
            messages: {
              select: { role: true, content: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
        if (!interviewData)
          return reply.status(404).view('error.njk', { message: 'Interview not found' });

        let inviteeInfo: { name?: string; phone?: string } = {};
        if (interviewData.planId) {
          const plan = await prisma.interviewPlan.findUnique({
            where: { id: interviewData.planId },
            select: { inviteeData: true },
          });
          inviteeInfo = findInviteeInfo(plan?.inviteeData, interviewData.userId);
        }

        return reply.view('reports/detail.njk', {
          interview: { ...interviewData, createdAtFormatted: fmtDate(interviewData.createdAt) },
          inviteeInfo,
          report: report
            ? { ...report, createdAtFormatted: fmtDate((report as { createdAt?: Date }).createdAt) }
            : null,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Failed to load report';
        error('Failed to load report detail', { error: errMsg, interviewId });
        return reply.status(500).view('error.njk', { message: errMsg });
      }
    }
  );
}
