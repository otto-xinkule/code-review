/**
 * Review Suggestion Prompt Template
 *
 * Generates actionable code review suggestions covering
 * code style, performance improvements, testing, and documentation.
 */

export const SUGGESTION_SYSTEM_PROMPT = `You are an experienced code reviewer providing constructive feedback. Your task is to generate actionable suggestions for improving code quality.

Guidelines:
1. Be specific - reference exact code and line numbers
2. Be constructive - explain WHY and HOW, not just WHAT
3. Be practical - suggest realistic improvements that add value
4. Prioritize - focus on the most impactful suggestions
5. Be respectful - maintain a collaborative tone

For each suggestion, include:
- The problem or opportunity for improvement
- A concrete code-level fix
- The reasoning behind your suggestion

Avoid:
- Nitpicking on trivial style choices (unless genuinely harmful)
- Suggesting changes that would require major architectural refactors (unless necessary)
- Making suggestions without clear benefits`;

export const SUGGESTION_USER_PROMPT = `Review the following code changes and provide improvement suggestions.

## Context
{{CONTEXT}}

## Existing Issues (from risk analysis)
{{EXISTING_ISSUES}}

## Instructions
Provide suggestions for code improvement in this JSON format:

{
  "suggestions": [
    {
      "id": "suggest-unique-id",
      "type": "must_fix|recommended|optional",
      "category": "style|performance|security|logic|testing|documentation|architecture",
      "title": "Brief suggestion title",
      "description": "What should be improved and why",
      "file": "path/to/file.ts",
      "lineRange": {
        "start": 10,
        "end": 15
      },
      "currentCode": "const x = oldWay();",
      "suggestedCode": "const x = await newWay();",
      "reasoning": "This change improves performance because...",
      "references": ["https://example.com/best-practices"]
    }
  ]
}

Focus on:
- Code style and readability improvements
- Performance optimizations
- Test coverage suggestions
- Documentation improvements
- Architecture suggestions (only if significant)

Do NOT duplicate issues from the risk analysis. Focus on suggestions beyond risk detection.
Respond with valid JSON only.`;

export interface SuggestionTemplateVars {
  CONTEXT: string;
  EXISTING_ISSUES: string;
}

export function renderSuggestionPrompt(vars: SuggestionTemplateVars): string {
  let prompt = SUGGESTION_USER_PROMPT;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, String(value));
  }
  return prompt;
}
