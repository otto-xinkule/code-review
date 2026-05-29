/**
 * Risk Detection Prompt Template
 *
 * Guides the AI to identify security vulnerabilities, performance issues,
 * potential bugs, logic errors, and maintainability concerns in code changes.
 */

export const RISK_SYSTEM_PROMPT = `You are an expert security and code quality auditor. Your task is to analyze code changes and identify potential risks.

Focus on these risk categories:
1. SECURITY: SQL injection, XSS, hardcoded credentials, unvalidated input, path traversal, sensitive data exposure
2. PERFORMANCE: N+1 queries, inefficient loops, memory leaks, synchronous blocking operations, unnecessary object creation
3. BUG: Null pointer access, boundary conditions, exception handling, incorrect async/await, race conditions
4. LOGIC: Missing edge cases, incorrect conditions, algorithm correctness, state machine errors
5. MAINTAINABILITY: Overly complex code, deep nesting, magic numbers, commented-out code, missing error handling

For each issue found, provide:
- Clear explanation of WHY it's a problem
- The specific code that is problematic
- Severity assessment
- Confidence level in your assessment

IMPORTANT: Only report real issues. Do not fabricate problems.
If code looks correct, report no issues for that category.
Be conservative - only flag things you are reasonably confident about.`;

export const RISK_USER_PROMPT = `Analyze the following code changes for potential risks. Report ALL issues you find.

## Context
{{CONTEXT}}

## Risk Categories to Check
{{RISK_CATEGORIES}}

## Minimum Severity to Report
{{MIN_SEVERITY}}

## Instructions
For each issue found, provide a structured response in this JSON format:

{
  "summary": "Overall risk assessment summary",
  "overallScore": 45,
  "issues": [
    {
      "id": "unique-id",
      "category": "security|performance|bug|logic|maintainability",
      "severity": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "title": "Brief issue title",
      "description": "Detailed explanation of the problem",
      "file": "path/to/file.ts",
      "lineRange": {
        "start": 42,
        "end": 45
      },
      "codeSnippet": "const x = dangerousOperation();",
      "suggestion": "Use safeOperation() instead and add null check",
      "score": 85,
      "ruleIds": ["CWE-89"]
    }
  ],
  "byCategory": {
    "security": 1,
    "performance": 0,
    "bug": 2,
    "logic": 1,
    "maintainability": 1
  },
  "bySeverity": {
    "critical": 1,
    "high": 2,
    "medium": 1,
    "low": 1
  },
  "highRiskFiles": ["path/to/critical/file.ts"]
}

Respond with valid JSON only.`;

export interface RiskTemplateVars {
  CONTEXT: string;
  RISK_CATEGORIES: string;
  MIN_SEVERITY: string;
}

export function renderRiskPrompt(vars: RiskTemplateVars): string {
  let prompt = RISK_USER_PROMPT;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, String(value));
  }
  return prompt;
}
