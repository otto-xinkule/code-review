/**
 * PR Summary Prompt Template
 *
 * Generates a structured summary of PR changes including
 * change type classification, affected modules, key files,
 * dependency changes, and impact analysis.
 */

export const SUMMARY_SYSTEM_PROMPT = `You are an expert code reviewer analyzing a Pull Request. Your task is to generate a concise, structured summary of the changes.

Focus on:
1. Understanding the intent behind the changes
2. Identifying the scope and impact of modifications
3. Classifying the change type accurately
4. Highlighting the most important files for human reviewers

Be factual and precise. Do not speculate beyond what is visible in the diff.
Avoid being overly verbose - reviewers use this summary to quickly understand the PR.`;

export const SUMMARY_USER_PROMPT = `Analyze the following Pull Request changes and provide a structured summary in JSON format.

## PR Information
Title: {{PR_TITLE}}
Description: {{PR_BODY}}
Author: {{PR_AUTHOR}}
Changed Files: {{FILE_COUNT}}
Additions: +{{ADDITIONS}} / Deletions: -{{DELETIONS}}

## Context
{{CONTEXT}}

Respond with a JSON object in this exact structure:

{
  "title": "One-line summary of what this PR does",
  "description": "A paragraph describing the changes, their purpose, and scope",
  "changeType": "feature|bugfix|refactor|performance|docs|test|chore|mixed",
  "affectedModules": ["list", "of", "affected", "modules/systems"],
  "keyFiles": [
    {
      "filename": "path/to/file.ts",
      "reason": "Why this file is important for review",
      "complexity": 75,
      "changes": 42
    }
  ],
  "dependencyChanges": [
    {
      "name": "package-name",
      "type": "added|removed|updated|replaced",
      "oldVersion": "1.0.0",
      "newVersion": "2.0.0",
      "file": "package.json"
    }
  ],
  "impact": {
    "level": "none|low|medium|high|critical",
    "affectedAreas": ["area1", "area2"],
    "upstreamDependencies": ["caller1", "caller2"],
    "downstreamDependencies": ["service1", "service2"],
    "hasDatabaseChanges": false,
    "hasAPIChanges": false,
    "hasConfigChanges": false,
    "migrationNotes": "Any migration notes if applicable, or null"
  },
  "statistics": {
    "filesChanged": 0,
    "additions": 0,
    "deletions": 0,
    "byLanguage": {"TypeScript": 5},
    "byType": {"feature": 3, "refactor": 2}
  }
}`;

// ============================================================
// Template variable substitution
// ============================================================

export interface SummaryTemplateVars {
  PR_TITLE: string;
  PR_BODY: string;
  PR_AUTHOR: string;
  FILE_COUNT: number;
  ADDITIONS: number;
  DELETIONS: number;
  CONTEXT: string;
}

export function renderSummaryPrompt(vars: SummaryTemplateVars): string {
  let prompt = SUMMARY_USER_PROMPT;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, String(value));
  }
  return prompt;
}
