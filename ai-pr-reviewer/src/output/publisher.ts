import type { ReviewResult, ReviewOutput } from '../types/index.js';
import { logger } from '../utility/logger.js';
import { getConfig } from '../config/index.js';
import {
  createPRReview,
  createIssueComment,
  deleteComment,
  updateComment,
  findPreviousAIComments,
} from '../collectors/github-api.js';
import { formatReviewOutput } from './formatter.js';
import { validateReviewResult } from './validator.js';
import { metrics } from '../utility/metrics.js';

/**
 * Output Publisher
 *
 * Publishes AI review results to GitHub PR pages.
 * Supports:
 * - New PR review creation
 * - Updating existing reviews (on PR sync)
 * - Fallback to issue comments
 * - Review event determination (approve/comment/request changes)
 */

export interface PublishResult {
  success: boolean;
  reviewId?: number;
  commentId?: number;
  wasUpdated: boolean;
  error?: string;
}

/**
 * Publish review results to a PR.
 */
export async function publishReview(
  repository: string,
  prNumber: number,
  result: ReviewResult,
): Promise<PublishResult> {
  const config = getConfig();

  logger.info({ repository, prNumber }, 'Publishing review');

  // Validate the result before publishing
  const validation = validateReviewResult(result);
  if (!validation.isValid) {
    logger.warn({ errors: validation.errors }, 'Review result has validation errors');

    // Still publish if only warnings, but log the issues
    if (validation.errors.length > 3) {
      logger.error('Too many validation errors, aborting publish');
      return {
        success: false,
        error: `Validation failed: ${validation.errors.slice(0, 3).join('; ')}`,
      };
    }
  }

  if (validation.sanitized) {
    logger.warn('Review result required sanitization before publishing');
  }

  // Format the output
  const output = formatReviewOutput(result);

  // Handle auto-update: remove old AI comments on PR sync
  if (config.review.enabledFeatures.autoUpdateReview && result.pr.isUpdate) {
    await cleanupPreviousReviews(repository, prNumber);
  }

  // Publish as PR review (with inline comments)
  try {
    const reviewId = await createPRReview(repository, prNumber, output);

    metrics.recordEvent('review_published', 1, {
      repository,
      prNumber,
      type: 'review',
      event: output.reviewEvent,
      inlineComments: output.inlineComments.length,
    });

    logger.info({ reviewId }, 'Review published successfully');

    return {
      success: true,
      reviewId,
      wasUpdated: result.pr.isUpdate,
    };
  } catch (error) {
    logger.warn(
      { error: String(error) },
      'Failed to create PR review, falling back to issue comment',
    );

    // Fallback: post as issue comment
    try {
      const commentId = await createIssueComment(
        repository,
        prNumber,
        output.prComment,
      );

      metrics.recordEvent('review_published', 1, {
        repository,
        prNumber,
        type: 'comment',
        event: 'COMMENT',
      });

      logger.info({ commentId }, 'Review published as issue comment (fallback)');

      return {
        success: true,
        commentId,
        wasUpdated: result.pr.isUpdate,
      };
    } catch (fallbackError) {
      logger.error(
        { error: String(fallbackError) },
        'Failed to publish review via all methods',
      );

      return {
        success: false,
        error: `Failed to publish: ${String(fallbackError)}`,
      };
    }
  }
}

/**
 * Clean up previous AI review comments on a PR.
 * Used when PR is synchronized (new commits pushed).
 */
async function cleanupPreviousReviews(
  repository: string,
  prNumber: number,
): Promise<void> {
  try {
    const previousComments = await findPreviousAIComments(repository, prNumber);

    if (previousComments.length === 0) return;

    logger.info(
      { count: previousComments.length },
      'Cleaning up previous AI review comments',
    );

    for (const comment of previousComments) {
      try {
        await deleteComment(repository, comment.id);
      } catch (error) {
        logger.warn(
          { commentId: comment.id, error: String(error) },
          'Failed to delete previous comment',
        );
      }
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to clean up previous reviews');
  }
}

/**
 * Publish only the summary as a comment (no inline comments).
 * Useful for quick-reviews or preview mode.
 */
export async function publishSummaryOnly(
  repository: string,
  prNumber: number,
  result: ReviewResult,
): Promise<PublishResult> {
  const output = formatReviewOutput(result);

  try {
    const commentId = await createIssueComment(repository, prNumber, output.prComment);

    return {
      success: true,
      commentId,
      wasUpdated: false,
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}

/**
 * Check if a PR already has an AI review.
 */
export async function hasExistingReview(
  repository: string,
  prNumber: number,
): Promise<boolean> {
  const previousReviews = await findPreviousAIComments(repository, prNumber);
  return previousReviews.length > 0;
}

export default { publishReview, publishSummaryOnly, hasExistingReview };
