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
import { handlePREvent } from '../index.js';
import { parseWebhookEvent } from '../collectors/github-api.js';

// ESM compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = getConfig();

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

    // Manual trigger endpoint (for testing)
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

        // Create a synthetic PR event
        const event = {
          action: 'opened' as const,
          pr: {
            repository,
            prNumber: pr,
            title: 'Manual review',
            body: null,
            author: 'manual',
            baseBranch: 'main',
            headBranch: 'feature',
            baseSha: '',
            headSha: '',
            state: 'open' as const,
            isDraft: false,
            labels: [],
            linkedIssues: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            isUpdate: false,
          },
          repository: {
            owner: repository.split('/')[0],
            repo: repository.split('/')[1] || '',
            defaultBranch: 'main',
          },
        };

        res.json({ message: 'Review queued' });
        await handlePREvent(event);
      } catch (error) {
        logger.error({ error: String(error) }, 'Manual review error');
        res.status(500).json({ error: 'Internal server error' });
      }
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
