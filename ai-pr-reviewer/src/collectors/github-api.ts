import { Octokit } from '@octokit/rest';
import type { PRMetadata, PRFile, PREvent, InlineComment, ReviewOutput } from '../types/index.js';
import { logger } from '../utility/logger.js';
import { withRetry } from '../utility/retry.js';
import { getConfig } from '../config/index.js';

/**
 * GitHub API client for PR data collection and review publishing.
 * Handles authentication, rate limiting, pagination, and error recovery.
 */

let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!_octokit) {
    const config = getConfig();
    _octokit = new Octokit({
      auth: config.github.token,
      request: {
        timeout: config.advanced.requestTimeout,
      },
    });
  }
  return _octokit;
}

function parseRepo(repository: string): { owner: string; repo: string } {
  const parts = repository.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid repository format: "${repository}". Expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Fetch PR metadata including title, body, author, branches, etc.
 */
export async function getPRMetadata(
  repository: string,
  prNumber: number,
): Promise<PRMetadata> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info({ repository, prNumber }, 'Fetching PR metadata');

  const { data } = await withRetry(
    () => octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    { maxRetries: 3 },
  );

  // Fetch linked issues via closing keywords in body
  const linkedIssues = extractLinkedIssues(data.body || '');

  const metadata: PRMetadata = {
    repository,
    prNumber,
    title: data.title,
    body: data.body || null,
    author: data.user?.login || 'unknown',
    baseBranch: data.base.ref,
    headBranch: data.head.ref,
    baseSha: data.base.sha,
    headSha: data.head.sha,
    state: data.state as 'open' | 'closed' | 'merged',
    isDraft: data.draft || false,
    labels: data.labels?.map((l) => (typeof l === 'string' ? l : l.name || '')) || [],
    linkedIssues,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changed_files,
    isUpdate: false,
  };

  logger.debug({ metadata }, 'PR metadata fetched');
  return metadata;
}

/**
 * Fetch all changed files in a PR with their patches.
 */
export async function getPRFiles(
  repository: string,
  prNumber: number,
): Promise<PRFile[]> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info({ repository, prNumber }, 'Fetching PR files');

  const files: PRFile[] = [];

  // Use pagination to get all files
  await withRetry(
    () =>
      octokit.paginate(
        octokit.pulls.listFiles,
        {
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        },
        (response) => {
          for (const file of response.data) {
            files.push({
              filename: file.filename,
              status: file.status as PRFile['status'],
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
              patch: file.patch || null,
              previousFilename: file.previous_filename,
              contentsUrl: file.contents_url,
              sha: file.sha,
            });
          }
          return response.data;
        },
      ),
    { maxRetries: 3 },
  );

  logger.info({ fileCount: files.length }, `Fetched ${files.length} changed files`);
  return files;
}

/**
 * Fetch the raw unified diff for a PR.
 */
export async function getPRDiff(
  repository: string,
  prNumber: number,
): Promise<string> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info({ repository, prNumber }, 'Fetching PR diff');

  const { data } = await withRetry(
    () =>
      octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        headers: {
          accept: 'application/vnd.github.v3.diff',
        },
      }),
    { maxRetries: 3 },
  );

  const diff = typeof data === 'string' ? data : JSON.stringify(data);
  logger.info({ diffSize: diff.length }, `Fetched diff (${diff.length} bytes)`);
  return diff;
}

/**
 * Fetch all comments on a PR (review comments + issue comments).
 */
export async function getPRComments(
  repository: string,
  prNumber: number,
): Promise<{
  reviewComments: Array<{ id: number; body: string; path: string; line: number; user: string; createdAt: string }>;
  issueComments: Array<{ id: number; body: string; user: string; createdAt: string }>;
}> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info({ repository, prNumber }, 'Fetching PR comments');

  const [reviewComments, issueComments] = await Promise.all([
    withRetry(
      async () => {
        const comments: typeof reviewComments = [];
        await octokit.paginate(
          octokit.pulls.listReviewComments,
          { owner, repo, pull_number: prNumber, per_page: 100 },
          (response) => {
            for (const c of response.data) {
              comments.push({
                id: c.id,
                body: c.body || '',
                path: c.path,
                line: c.line || c.original_position || 1,
                user: c.user?.login || 'unknown',
                createdAt: c.created_at,
              });
            }
            return response.data;
          },
        );
        return comments;
      },
      { maxRetries: 3 },
    ),
    withRetry(
      async () => {
        const comments: typeof issueComments = [];
        await octokit.paginate(
          octokit.issues.listComments,
          { owner, repo, issue_number: prNumber, per_page: 100 },
          (response) => {
            for (const c of response.data) {
              comments.push({
                id: c.id,
                body: c.body || '',
                user: c.user?.login || 'unknown',
                createdAt: c.created_at,
              });
            }
            return response.data;
          },
        );
        return comments;
      },
      { maxRetries: 3 },
    ),
  ]);

  logger.info(
    { reviewComments: reviewComments.length, issueComments: issueComments.length },
    'Fetched PR comments',
  );

  return { reviewComments, issueComments };
}

/**
 * Extract linked issue numbers from PR body text using closing keywords.
 */
function extractLinkedIssues(body: string): number[] {
  const issueNumbers: number[] = [];
  const closingPattern = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = closingPattern.exec(body)) !== null) {
    issueNumbers.push(parseInt(match[1], 10));
  }
  return [...new Set(issueNumbers)];
}

/**
 * Fetch linked issue details.
 */
export async function getLinkedIssues(
  repository: string,
  issueNumbers: number[],
): Promise<Array<{ number: number; title: string; body: string; labels: string[] }>> {
  if (issueNumbers.length === 0) return [];

  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info({ issueNumbers }, 'Fetching linked issues');

  const issues = await Promise.all(
    issueNumbers.map(async (num) => {
      try {
        const { data } = await withRetry(
          () => octokit.issues.get({ owner, repo, issue_number: num }),
          { maxRetries: 2 },
        );
        return {
          number: num,
          title: data.title,
          body: data.body || '',
          labels: data.labels?.map((l) => (typeof l === 'string' ? l : l.name || '')) || [],
        };
      } catch (error) {
        logger.warn({ issueNumber: num, error: String(error) }, 'Failed to fetch linked issue');
        return null;
      }
    }),
  );

  return issues.filter((i): i is NonNullable<typeof i> => i !== null);
}

/**
 * Check if a PR exists and is open.
 */
export async function checkPRExists(
  repository: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const metadata = await getPRMetadata(repository, prNumber);
    return metadata.state === 'open';
  } catch (error) {
    logger.warn({ repository, prNumber, error: String(error) }, 'PR existence check failed');
    return false;
  }
}

/**
 * Create a PR review with inline comments.
 */
export async function createPRReview(
  repository: string,
  prNumber: number,
  reviewOutput: ReviewOutput,
  commitId?: string,
): Promise<number> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info(
    {
      repository,
      prNumber,
      event: reviewOutput.reviewEvent,
      inlineComments: reviewOutput.inlineComments.length,
    },
    'Creating PR review',
  );

  // Get the latest commit SHA if not provided
  let headSha = commitId;
  if (!headSha) {
    const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    headSha = data.head.sha;
  }

  // Prepare comments array for the review
  const comments: Array<{
    path: string;
    position: number;
    body: string;
  }> = [];

  // For GitHub PR review, we need the position in the diff, not the line number.
  // We approximate by using the line number as position for new file changes.
  for (const comment of reviewOutput.inlineComments) {
    // We need to calculate the diff position from line numbers
    // For simplicity, use line number as position for new files
    const position = comment.line;

    comments.push({
      path: comment.path,
      position,
      body: comment.body,
    });
  }

  try {
    const { data } = await withRetry(
      () =>
        octokit.pulls.createReview({
          owner,
          repo,
          pull_number: prNumber,
          commit_id: headSha,
          body: reviewOutput.reviewSummary,
          event: reviewOutput.reviewEvent,
          comments,
        }),
      { maxRetries: 3 },
    );

    logger.info({ reviewId: data.id }, 'PR review created');
    return data.id;
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to create PR review');

    // Fallback: post as issue comment
    await createIssueComment(repository, prNumber, reviewOutput.prComment);

    throw error;
  }
}

/**
 * Create an issue comment on a PR.
 */
export async function createIssueComment(
  repository: string,
  prNumber: number,
  body: string,
): Promise<number> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info({ repository, prNumber, bodyLength: body.length }, 'Creating issue comment');

  const { data } = await withRetry(
    () =>
      octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      }),
    { maxRetries: 3 },
  );

  logger.info({ commentId: data.id }, 'Issue comment created');
  return data.id;
}

/**
 * Delete a comment by ID.
 */
export async function deleteComment(
  repository: string,
  commentId: number,
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info({ repository, commentId }, 'Deleting comment');

  await withRetry(
    () => octokit.issues.deleteComment({ owner, repo, comment_id: commentId }),
    { maxRetries: 2 },
  );

  logger.info({ commentId }, 'Comment deleted');
}

/**
 * Update an existing comment.
 */
export async function updateComment(
  repository: string,
  commentId: number,
  body: string,
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(repository);

  logger.info({ repository, commentId }, 'Updating comment');

  await withRetry(
    () =>
      octokit.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      }),
    { maxRetries: 2 },
  );

  logger.info({ commentId }, 'Comment updated');
}

/**
 * Find previous AI review comments on a PR.
 * Used for auto-update functionality when PR changes.
 */
export async function findPreviousAIComments(
  repository: string,
  prNumber: number,
): Promise<Array<{ id: number; body: string }>> {
  const { issueComments } = await getPRComments(repository, prNumber);

  // Identify AI review comments by a marker
  const aiMarker = '<!-- AI-PR-REVIEW -->';

  return issueComments
    .filter((c) => c.body.includes(aiMarker))
    .map((c) => ({ id: c.id, body: c.body }));
}

/**
 * Parse a GitHub webhook event into our PREvent format.
 */
export function parseWebhookEvent(payload: Record<string, unknown>): PREvent {
  const action = payload.action as PREvent['action'];
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;

  if (!pr || !repo) {
    throw new Error('Invalid webhook payload: missing pull_request or repository');
  }

  return {
    action,
    pr: {
      repository: repo.full_name as string,
      prNumber: pr.number as number,
      title: pr.title as string,
      body: (pr.body as string) || null,
      author: ((pr.user as Record<string, unknown>)?.login as string) || 'unknown',
      baseBranch: (pr.base as Record<string, unknown>)?.ref as string,
      headBranch: (pr.head as Record<string, unknown>)?.ref as string,
      baseSha: (pr.base as Record<string, unknown>)?.sha as string,
      headSha: (pr.head as Record<string, unknown>)?.sha as string,
      state: pr.state as 'open' | 'closed' | 'merged',
      isDraft: (pr.draft as boolean) || false,
      labels: (pr.labels as Array<Record<string, unknown>>)?.map((l) => l.name as string) || [],
      linkedIssues: extractLinkedIssues((pr.body as string) || ''),
      createdAt: pr.created_at as string,
      updatedAt: pr.updated_at as string,
      additions: pr.additions as number,
      deletions: pr.deletions as number,
      changedFiles: pr.changed_files as number,
      isUpdate: action === 'synchronize',
    },
    repository: {
      owner: (repo.owner as Record<string, unknown>)?.login as string,
      repo: repo.name as string,
      defaultBranch: repo.default_branch as string,
    },
    installationId: payload.installation
      ? (payload.installation as Record<string, unknown>)?.id as number
      : undefined,
  };
}

export default {
  getPRMetadata,
  getPRFiles,
  getPRDiff,
  getPRComments,
  getLinkedIssues,
  checkPRExists,
  createPRReview,
  createIssueComment,
  deleteComment,
  updateComment,
  findPreviousAIComments,
  parseWebhookEvent,
};
