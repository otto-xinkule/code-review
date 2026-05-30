#!/usr/bin/env node

/**
 * Webhook Service
 *
 * Standalone HTTP server that listens for GitHub webhook events.
 * Provides higher throughput and more flexibility than GitHub Actions.
 *
 * Supports:
 * - PR event handling (opened, synchronize, reopened)
 * - Webhook signature verification
 * - Concurrent review processing with queue management
 * - Health check endpoint
 * - Metrics endpoint
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utility/logger.js';
import { metrics } from '../utility/metrics.js';
import { getConfig } from '../config/index.js';
import { handlePREvent, reviewPR } from '../index.js';
import { parseWebhookEvent } from '../collectors/github-api.js';
import type { ReviewResult } from '../types/index.js';

// ESM compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = getConfig();

// Review result storage type for async polling
type ReviewTask = {
  status: 'processing' | 'completed' | 'error';
  repository: string;
  prNumber: number;
  createdAt: number;
  result?: ReviewResult;
  error?: string;
  feedback: Record<string, 'accept' | 'reject'>;
};

/**
 * Webhook Service class.
 */
class WebhookService {
  private app: express.Application;
  private port: number;
  private secret: string;
  private isRunning: boolean = false;
  private activeReviews: Set<string> = new Set();
  private reviewQueue: Array<{
    repository: string;
    prNumber: number;
    event: string;
    timestamp: number;
  }> = [];
  private reviewTasks: Map<string, ReviewTask> = new Map();

  constructor() {
    this.app = express();
    this.port = config.github.webhookPort;
    this.secret = config.github.webhookSecret || '';

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Configure Express middleware.
   */
  private setupMiddleware(): void {
    // ----- Static file serving (frontend) -----
    // Resolve public directory relative to project root
    const publicDir = path.resolve(__dirname, '..', '..', 'public');
    logger.info({ publicDir }, 'Serving static files');
    this.app.use(express.static(publicDir));

    // Parse raw body for signature verification (skip for static files)
    this.app.use(
      express.json({
        verify: (req: Request, _res: Response, buf: Buffer) => {
          // Store raw body for signature verification
          (req as any).rawBody = buf.toString();
        },
      }),
    );

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      logger.debug(
        { method: req.method, path: req.path, ip: req.ip },
        'Incoming request',
      );
      next();
    });
  }

  /**
   * Configure routes.
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        activeReviews: this.activeReviews.size,
        queueSize: this.reviewQueue.length,
        uptime: process.uptime(),
        version: '1.0.0',
      });
    });

    // Metrics endpoint
    this.app.get('/metrics', (_req: Request, res: Response) => {
      const stats = metrics.getStats();
      res.json({
        ...stats,
        server: {
          activeReviews: this.activeReviews.size,
          queueSize: this.reviewQueue.length,
          uptime: process.uptime(),
        },
      });
    });

    // Main webhook endpoint
    this.app.post('/webhook', async (req: Request, res: Response) => {
      try {
        // Verify webhook signature
        if (this.secret && !this.verifySignature(req)) {
          logger.warn({ ip: req.ip }, 'Invalid webhook signature');
          res.status(403).json({ error: 'Invalid signature' });
          return;
        }

        // Extract event type
        const eventType = req.headers['x-github-event'] as string;
        const deliveryId = req.headers['x-github-delivery-id'] as string;

        if (!eventType) {
          res.status(400).json({ error: 'Missing X-GitHub-Event header' });
          return;
        }

        logger.info(
          { eventType, deliveryId },
          'Received webhook event',
        );

        // Handle ping events (webhook setup verification)
        if (eventType === 'ping') {
          res.json({ message: 'pong' });
          return;
        }

        // Handle PR events
        if (eventType === 'pull_request') {
          const action = req.body?.action;

          if (!['opened', 'synchronize', 'reopened'].includes(action)) {
            res.json({ message: `PR event "${action}" ignored` });
            return;
          }

          // Parse the event
          const event = parseWebhookEvent(req.body);

          // Respond immediately (async processing)
          res.json({
            message: 'Review queued',
            prNumber: event.pr.prNumber,
            action: event.action,
          });

          // Queue the review
          await this.queueReview(event);
        } else {
          res.json({ message: `Event "${eventType}" not processed` });
        }
      } catch (error) {
        logger.error({ error: String(error) }, 'Webhook processing error');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Manual trigger endpoint (returns taskId for async polling)
    this.app.post('/review', async (req: Request, res: Response) => {
      try {
        const { repository, prNumber } = req.body;

        if (!repository || !prNumber) {
          res.status(400).json({ error: 'Missing repository or prNumber' });
          return;
        }

        const pr = parseInt(prNumber, 10);
        if (isNaN(pr)) {
          res.status(400).json({ error: 'prNumber must be a number' });
          return;
        }

        // Generate task ID and store initial status
        const taskId = crypto.randomUUID();
        this.reviewTasks.set(taskId, {
          status: 'processing',
          repository,
          prNumber: pr,
          createdAt: Date.now(),
          feedback: {},
        });

        // Cleanup old tasks (> 1 hour)
        const oneHourAgo = Date.now() - 3600 * 1000;
        for (const [id, task] of this.reviewTasks) {
          if (task.createdAt < oneHourAgo) this.reviewTasks.delete(id);
        }

        // Return taskId immediately
        res.json({ taskId, message: 'Review started' });

        // Run review asynchronously
        (async () => {
          try {
            const result = await reviewPR(repository, pr, {
              useCache: false,
              forceReanalysis: false,
            });

            const task = this.reviewTasks.get(taskId);
            if (!task) return;

            if (result.success && result.result) {
              task.status = 'completed';
              task.result = result.result;
            } else {
              task.status = 'error';
              task.error = result.error || 'Unknown error';
            }
          } catch (err: any) {
            const task = this.reviewTasks.get(taskId);
            if (task) {
              task.status = 'error';
              task.error = err?.message || String(err);
            }
            logger.error({ taskId, error: String(err) }, 'Review task failed');
          }
        })();
      } catch (error) {
        logger.error({ error: String(error) }, 'Manual review error');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Poll review result by taskId
    this.app.get('/review/result', (req: Request, res: Response) => {
      const taskId = req.query.task as string;
      if (!taskId) {
        res.status(400).json({ error: 'Missing task parameter' });
        return;
      }

      const task = this.reviewTasks.get(taskId);
      if (!task) {
        res.status(404).json({ status: 'not_found', error: 'Task not found' });
        return;
      }

      if (task.status === 'processing') {
        res.json({ status: 'processing' });
        return;
      }

      if (task.status === 'error') {
        res.json({ status: 'error', error: task.error });
        return;
      }

      // completed — return full result + feedback
      res.json({ status: 'completed', result: task.result, feedback: task.feedback });
    });

    // Review history — list all completed reviews
    this.app.get('/review/history', (_req: Request, res: Response) => {
      const reviews: Array<{
        taskId: string;
        repository: string;
        prNumber: number;
        createdAt: number;
        score: number;
        issueCount: number;
        suggestionCount: number;
        model: string;
        summary: string;
        changeType: string;
      }> = [];

      for (const [taskId, task] of this.reviewTasks) {
        if (task.status !== 'completed' || !task.result) continue;
        const r = task.result;
        reviews.push({
          taskId,
          repository: task.repository,
          prNumber: task.prNumber,
          createdAt: task.createdAt,
          score: r.riskReport?.overallScore ?? 0,
          issueCount: r.riskReport?.issues?.length || 0,
          suggestionCount: r.suggestions?.length || 0,
          model: r.metadata?.model || 'unknown',
          summary: r.summary?.description || r.summary?.title || '',
          changeType: r.summary?.changeType || 'mixed',
        });
      }

      // Sort by most recent first
      reviews.sort((a, b) => b.createdAt - a.createdAt);
      res.json({ reviews });
    });

    // Aggregated risk/category stats for dashboard
    this.app.get('/review/stats', (_req: Request, res: Response) => {
      const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
      const byCategory: Record<string, number> = {
        security: 0, performance: 0, bug: 0, logic: 0, maintainability: 0,
      };
      const byChangeType: Record<string, number> = {};
      const scores: number[] = [];

      for (const [, task] of this.reviewTasks) {
        if (task.status !== 'completed' || !task.result) continue;
        const r = task.result;

        // Aggregate severities
        for (const issue of r.riskReport?.issues || []) {
          if (bySeverity[issue.severity] !== undefined) bySeverity[issue.severity]++;
          if (byCategory[issue.category] !== undefined) byCategory[issue.category]++;
        }

        // Change type
        const ct = r.summary?.changeType || 'mixed';
        byChangeType[ct] = (byChangeType[ct] || 0) + 1;

        // Scores
        if (typeof r.riskReport?.overallScore === 'number') {
          scores.push(r.riskReport.overallScore);
        }
      }

      const avgScore = scores.length > 0
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;

      res.json({ bySeverity, byCategory, byChangeType, avgScore, totalReviews: scores.length });
    });

    // Feedback — accept or reject a review issue/suggestion
    this.app.post('/api/feedback', (req: Request, res: Response) => {
      const { taskId, issueId, action } = req.body;
      if (!taskId || !issueId || !['accept', 'reject'].includes(action)) {
        res.status(400).json({ error: 'Missing or invalid fields' });
        return;
      }
      const task = this.reviewTasks.get(taskId);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      task.feedback[issueId] = action;
      logger.info({ taskId, issueId, action }, 'Feedback recorded');
      res.json({ success: true, feedback: task.feedback });
    });

    // Config endpoint (for frontend settings page)
    this.app.get('/api/config', (_req: Request, res: Response) => {
      const cfg = getConfig();
      // Mask sensitive values
      res.json({
        github: {
          token: cfg.github.token ? 'ghp_****' : null,
          repository: cfg.github.repository || null,
          webhookPort: cfg.github.webhookPort,
          webhookSecret: cfg.github.webhookSecret ? '****' : null,
        },
        models: {
          default: cfg.models.default,
          fallback: cfg.models.fallback,
          enableRouting: cfg.models.enableRouting,
          providers: Object.entries(cfg.models.providers).reduce(
            (acc, [name, modelCfg]) => ({
              ...acc,
              [name]: {
                modelId: modelCfg.modelId,
                hasApiKey: !!modelCfg.apiKey,
                priority: modelCfg.priority,
                capabilities: modelCfg.capabilities,
              },
            }),
            {} as Record<string, unknown>,
          ),
          router: cfg.models.router,
        },
        review: cfg.review,
        context: cfg.context,
        logging: cfg.logging,
        advanced: cfg.advanced,
      });
    });

    // 404 handler
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  /**
   * Verify the GitHub webhook signature.
   */
  private verifySignature(req: Request): boolean {
    const signature = req.headers['x-hub-signature-256'] as string;
    if (!signature) {
      logger.warn('No signature header found');
      return false;
    }

    const rawBody = (req as any).rawBody || JSON.stringify(req.body);
    const computed = 'sha256=' + crypto
      .createHmac('sha256', this.secret)
      .update(rawBody)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(computed),
      );
    } catch {
      return false;
    }
  }

  /**
   * Queue a PR review for async processing.
   */
  private async queueReview(event: any): Promise<void> {
    const reviewKey = `${event.repository.owner}/${event.repository.repo}#${event.pr.prNumber}`;

    // Skip if already being reviewed
    if (this.activeReviews.has(reviewKey)) {
      logger.info({ reviewKey }, 'Review already in progress, skipping duplicate');
      return;
    }

    this.reviewQueue.push({
      repository: `${event.repository.owner}/${event.repository.repo}`,
      prNumber: event.pr.prNumber,
      event: event.action,
      timestamp: Date.now(),
    });

    // Process queue
    this.processQueue();
  }

  /**
   * Process queued reviews (one at a time to avoid rate limits).
   */
  private async processQueue(): Promise<void> {
    if (this.reviewQueue.length === 0) return;

    const review = this.reviewQueue.shift()!;
    const reviewKey = `${review.repository}#${review.prNumber}`;

    this.activeReviews.add(reviewKey);

    try {
      logger.info(
        { reviewKey, queueRemaining: this.reviewQueue.length },
        'Processing review from queue',
      );

      // Process via handlePREvent
      const event = {
        action: review.event as 'opened' | 'synchronize' | 'reopened',
        pr: {
          repository: review.repository,
          prNumber: review.prNumber,
          title: '',
          body: null,
          author: '',
          baseBranch: '',
          headBranch: '',
          baseSha: '',
          headSha: '',
          state: 'open' as const,
          isDraft: false,
          labels: [],
          linkedIssues: [],
          createdAt: '',
          updatedAt: '',
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          isUpdate: review.event === 'synchronize',
        },
        repository: {
          owner: review.repository.split('/')[0],
          repo: review.repository.split('/')[1] || '',
          defaultBranch: 'main',
        },
      };

      await handlePREvent(event);
    } catch (error) {
      logger.error(
        { reviewKey, error: String(error) },
        'Failed to process review',
      );
    } finally {
      this.activeReviews.delete(reviewKey);

      // Process next in queue
      if (this.reviewQueue.length > 0) {
        setTimeout(() => this.processQueue(), 1000); // Rate limit buffer
      }
    }
  }

  /**
   * Start the server.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Server is already running');
      return;
    }

    this.app.listen(this.port, () => {
      this.isRunning = true;
      logger.info(
        {
          port: this.port,
          endpoints: [
            `http://localhost:${this.port}/webhook`,
            `http://localhost:${this.port}/health`,
            `http://localhost:${this.port}/metrics`,
          ],
        },
        'Webhook server started',
      );

      if (!this.secret) {
        logger.warn(
          'WEBHOOK_SECRET is not configured. Webhook signature verification is disabled. ' +
          'This is insecure and should only be used for development.',
        );
      }
    });
  }

  /**
   * Stop the server gracefully.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Server is not running');
      return;
    }

    logger.info('Shutting down webhook server...');

    // Wait for active reviews to complete (with timeout)
    if (this.activeReviews.size > 0) {
      logger.info({ active: this.activeReviews.size }, 'Waiting for active reviews to complete');
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.activeReviews.size === 0) {
            resolve();
          } else {
            setTimeout(check, 1000);
          }
        };
        check();
        // Timeout after 5 minutes
        setTimeout(resolve, 5 * 60 * 1000);
      });
    }

    this.isRunning = false;
    logger.info('Webhook server stopped');
    process.exit(0);
  }
}

/**
 * Main entry point for the webhook server.
 */
async function main(): Promise<void> {
  const service = new WebhookService();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT');
    await service.stop();
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM');
    await service.stop();
  });

  process.on('uncaughtException', (error) => {
    logger.error({ error: String(error) }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'Unhandled rejection');
  });

  service.start();
}

// Execute if this is the main module
if (require.main === module) {
  main().catch((error) => {
    logger.error({ error: String(error) }, 'Failed to start webhook server');
    process.exit(1);
  });
}

export { WebhookService };
export default WebhookService;
