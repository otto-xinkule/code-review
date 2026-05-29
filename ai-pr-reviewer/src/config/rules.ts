/**
 * Review Rules Configuration
 *
 * Defines customizable review rules, risk patterns, and severity mappings.
 * Users can extend these rules for team-specific requirements.
 */

import type { RiskCategory, Severity } from '../types/index.js';

export interface ReviewRule {
  /** Rule unique ID */
  id: string;
  /** Rule name */
  name: string;
  /** Risk category */
  category: RiskCategory;
  /** Default severity */
  severity: Severity;
  /** Regex patterns to match (for static pre-filtering) */
  patterns: RegExp[];
  /** Description of the rule */
  description: string;
  /** Example of bad code */
  badExample: string;
  /** Example of good code */
  goodExample: string;
  /** Whether this rule is enabled by default */
  enabled: boolean;
  /** CWE/OWASP reference ID */
  referenceId?: string;
}

/**
 * Default built-in review rules.
 * Organized by risk category.
 */
export const BUILT_IN_RULES: ReviewRule[] = [
  // ===== Security Rules =====
  {
    id: 'SEC-001',
    name: 'Hard-coded credentials',
    category: 'security',
    severity: 'critical',
    patterns: [
      /(password|passwd|secret|api_key|apikey|token|auth_token)\s*[:=]\s*['"][^'"]{6,}['"]/i,
      /(aws_access_key|aws_secret|private_key|-----BEGIN)/i,
    ],
    description: 'Credentials or secrets appear to be hard-coded in source code. Use environment variables or a secrets manager.',
    badExample: `const apiKey = "sk-abc123def456";`,
    goodExample: `const apiKey = process.env.API_KEY;`,
    referenceId: 'CWE-798',
    enabled: true,
  },
  {
    id: 'SEC-002',
    name: 'SQL injection risk',
    category: 'security',
    severity: 'critical',
    patterns: [
      /(['"])\s*\+\s*\w+\s*\+\s*(['"])/,
      /execute\s*\(\s*['"`].*\$[\{\(]/,
      /\.query\s*\(\s*['"`].*\$[\{\(]/,
      /SELECT\s+.*\+.*FROM/i,
    ],
    description: 'SQL query appears to be constructed via string concatenation. Use parameterized queries or an ORM.',
    badExample: `db.query("SELECT * FROM users WHERE id = " + userId);`,
    goodExample: `db.query("SELECT * FROM users WHERE id = ?", [userId]);`,
    referenceId: 'CWE-89',
    enabled: true,
  },
  {
    id: 'SEC-003',
    name: 'XSS vulnerability',
    category: 'security',
    severity: 'high',
    patterns: [
      /dangerouslySetInnerHTML\s*=/,
      /innerHTML\s*=\s*(?!['"]\s*['"])/,
      /\.html\s*\(\s*(?!['"])/,
      /document\.write\s*\(/,
      /eval\s*\(/,
    ],
    description: 'User input may be rendered without proper sanitization, creating an XSS vulnerability.',
    badExample: `element.innerHTML = userInput;`,
    goodExample: `element.textContent = userInput;`,
    referenceId: 'CWE-79',
    enabled: true,
  },
  {
    id: 'SEC-004',
    name: 'Unvalidated user input',
    category: 'security',
    severity: 'high',
    patterns: [
      /req\.(body|query|params)\[['"]\w+['"]\](?!\s*\.)|req\.(body|query|params)\.\w+(?!\s*$)/,
    ],
    description: 'User input is used without validation. Validate and sanitize all user inputs.',
    badExample: `const file = req.body.filePath;\nfs.readFile(file, ...)`,
    goodExample: `const file = path.resolve(UPLOAD_DIR, path.basename(req.body.filePath));`,
    referenceId: 'CWE-20',
    enabled: true,
  },
  {
    id: 'SEC-005',
    name: 'Path traversal risk',
    category: 'security',
    severity: 'high',
    patterns: [
      /\.\.\/|\.\.\\/,
      /path\.join\s*\(\s*['"]*[^'"]*req\./,
      /path\.resolve\s*\(\s*['"]*[^'"]*req\./,
    ],
    description: 'File paths may be constructed from user input, creating a path traversal vulnerability.',
    badExample: `fs.readFile(path.join("data", req.query.file))`,
    goodExample: `const safePath = path.resolve(BASE_DIR, path.basename(req.query.file));`,
    referenceId: 'CWE-22',
    enabled: true,
  },

  // ===== Performance Rules =====
  {
    id: 'PERF-001',
    name: 'N+1 query pattern',
    category: 'performance',
    severity: 'high',
    patterns: [
      /\.forEach\s*\([^)]*\bawait\b.*query/i,
      /for\s*\([^)]*\)\s*{[^}]*\bawait\b.*\.(find|query|get)/i,
      /\.map\s*\([^)]*\bawait\b.*\.(find|query)/i,
      /Promise\.all\s*\(\s*\w+\.map\s*\([^)]*\bawait\b/,
    ],
    description: 'Database queries are being executed in a loop. Use batch queries or joins to avoid N+1 queries.',
    badExample: `for (const user of users) {\n  const posts = await db.query("SELECT * FROM posts WHERE userId = ?", [user.id]);\n}`,
    goodExample: `const userIds = users.map(u => u.id);\nconst posts = await db.query("SELECT * FROM posts WHERE userId IN (?)", [userIds]);`,
    enabled: true,
  },
  {
    id: 'PERF-002',
    name: 'Large object creation in loop',
    category: 'performance',
    severity: 'medium',
    patterns: [
      /for\s*\([^)]*\)\s*{[^}]*new\s+(Array|Object|Map|Set|Date)/i,
    ],
    description: 'Objects are being created inside a loop, which may cause memory pressure. Consider reusing objects.',
    badExample: `for (const item of items) {\n  const result = new Result(heavyComputation(item));\n}`,
    goodExample: `const result = new Result();\nfor (const item of items) {\n  result.add(heavyComputation(item));\n}`,
    enabled: true,
  },
  {
    id: 'PERF-003',
    name: 'Synchronous blocking operation',
    category: 'performance',
    severity: 'high',
    patterns: [
      /readFileSync\s*\(/,
      /writeFileSync\s*\(/,
      /existsSync\s*\(/,
      /execSync\s*\(/,
      /spawnSync\s*\(/,
    ],
    description: 'Synchronous I/O operation detected. Use async alternatives to avoid blocking the event loop.',
    badExample: `const data = fs.readFileSync(path);`,
    goodExample: `const data = await fs.promises.readFile(path);`,
    enabled: true,
  },
  {
    id: 'PERF-004',
    name: 'Missing memoization on expensive computation',
    category: 'performance',
    severity: 'medium',
    patterns: [
      /\.(filter|map|reduce|sort)\s*\([^)]*\)\.(filter|map|reduce|sort)/,
    ],
    description: 'Chained array operations may repeatedly iterate. Combine operations or use memoization.',
    badExample: `items.filter(x => x.active).map(x => compute(x)).filter(x => x > 0)`,
    goodExample: `items.reduce((acc, x) => { if (x.active) { const v = compute(x); if (v > 0) acc.push(v); } return acc; }, [])`,
    enabled: true,
  },
  {
    id: 'PERF-005',
    name: 'Memory leak potential',
    category: 'performance',
    severity: 'high',
    patterns: [
      /addEventListener\s*\((?!.*removeEventListener)/,
      /setInterval\s*\((?!.*clearInterval)/,
      /new\s+(Worker|EventSource|WebSocket)\s*\((?!.*close|terminate)/,
    ],
    description: 'Event listener or interval may not be cleaned up, leading to memory leaks.',
    badExample: `window.addEventListener('resize', handler);`,
    goodExample: `window.addEventListener('resize', handler);\n// In cleanup:\nwindow.removeEventListener('resize', handler);`,
    enabled: true,
  },

  // ===== Bug Rules =====
  {
    id: 'BUG-001',
    name: 'Null/undefined dereference risk',
    category: 'bug',
    severity: 'high',
    patterns: [
      /(\w+)\.\w+\s*(?!\s*[?.\[]|\s*&&\s*\1)/,
    ],
    description: 'Variable may be null or undefined when accessed. Add null check or use optional chaining.',
    badExample: `const name = user.profile.name;`,
    goodExample: `const name = user?.profile?.name ?? 'Unknown';`,
    enabled: true,
  },
  {
    id: 'BUG-002',
    name: 'Unhandled promise rejection',
    category: 'bug',
    severity: 'high',
    patterns: [
      /await\s+(?!\w+\(\))/,
      /\.then\s*\((?!.*\.catch)/,
    ],
    description: 'Promise may reject without error handling. Add try/catch or .catch() handler.',
    badExample: `const result = await fetch(url);`,
    goodExample: `try {\n  const result = await fetch(url);\n} catch (error) {\n  console.error('Failed to fetch:', error);\n}`,
    enabled: true,
  },
  {
    id: 'BUG-003',
    name: 'Equality vs strict equality',
    category: 'bug',
    severity: 'medium',
    patterns: [
      /(?<![!=])=?=\s*==\s*(?![!=])/,
    ],
    description: 'Using loose equality (==) may cause unexpected type coercion. Use strict equality (===) instead.',
    badExample: `if (value == "0") { /* matches 0, false, "", etc. */ }`,
    goodExample: `if (value === "0") { /* only matches string "0" */ }`,
    enabled: true,
  },
  {
    id: 'BUG-004',
    name: 'Incorrect async/await usage',
    category: 'bug',
    severity: 'high',
    patterns: [
      /async\s+function[^{]*{[^}]*(?<!\bawait\s)(?!.*\breturn\b)(?!.*\bthrow\b)\b\w+\(/,
    ],
    description: 'Async function does not use await, or Promise is not returned correctly.',
    badExample: `async function fetch() {\n  return db.query("SELECT ...");\n}`,
    goodExample: `async function fetch() {\n  return await db.query("SELECT ...");\n}`,
    enabled: true,
  },
  {
    id: 'BUG-005',
    name: 'Array index out of bounds',
    category: 'bug',
    severity: 'medium',
    patterns: [
      /\w+\[[\w.]+\s*\+\s*\d+\]/,
      /\w+\[\w+\.\s*length\s*]/,
    ],
    description: 'Potential array index out of bounds access. Add bounds checking.',
    badExample: `const last = items[items.length];`,
    goodExample: `const last = items[items.length - 1];`,
    enabled: true,
  },

  // ===== Logic Rules =====
  {
    id: 'LOGIC-001',
    name: 'Missing else/default clause',
    category: 'logic',
    severity: 'medium',
    patterns: [
      /if\s*\([^)]*\)\s*{[^}]*return[^}]*}(?![^}]*\belse\b)/,
    ],
    description: 'Conditional logic may be incomplete. Ensure all branches are handled.',
    badExample: `if (status === 'active') return processActive();\n// Missing: other statuses`,
    goodExample: `switch (status) {\n  case 'active': return processActive();\n  default: return processDefault();\n}`,
    enabled: true,
  },
  {
    id: 'LOGIC-002',
    name: 'Assignment in condition',
    category: 'logic',
    severity: 'medium',
    patterns: [
      /if\s*\([^)]*=\s*[^=]/,
    ],
    description: 'Assignment operator used in condition. This may be intentional but is error-prone.',
    badExample: `if (x = getValue()) { /* always uses assignment result */ }`,
    goodExample: `const x = getValue();\nif (x) { /* intentional check */ }`,
    enabled: true,
  },
  {
    id: 'LOGIC-003',
    name: 'Floating point comparison',
    category: 'logic',
    severity: 'low',
    patterns: [
      /if\s*\(\s*\d+\.\d+\s*[=!<>]+\s*\w[\w.]*\s*\)/,
    ],
    description: 'Direct floating point comparison may be unreliable. Use epsilon comparison.',
    badExample: `if (amount == 0.1 + 0.2) { /* may not pass */ }`,
    goodExample: `if (Math.abs(amount - 0.3) < Number.EPSILON) { /* reliable */ }`,
    enabled: true,
  },

  // ===== Maintainability Rules =====
  {
    id: 'MAINT-001',
    name: 'Excessively long function',
    category: 'maintainability',
    severity: 'medium',
    patterns: [], // Handled by AST/size analysis
    description: 'Function is too long (suggested max: 50 lines). Break into smaller, focused functions.',
    badExample: `function process() {\n  // 200+ lines of logic\n}`,
    goodExample: `function process() {\n  validate();\n  transform();\n  save();\n}`,
    enabled: true,
  },
  {
    id: 'MAINT-002',
    name: 'Magic numbers',
    category: 'maintainability',
    severity: 'low',
    patterns: [
      /(?<!")\b(?!0\b|1\b|2\b|-1\b)\d{2,}\b(?!"|,)/,
    ],
    description: 'Hard-coded numeric value found. Extract to a named constant.',
    badExample: `setTimeout(cleanup, 3600000);`,
    goodExample: `const ONE_HOUR = 60 * 60 * 1000;\nsetTimeout(cleanup, ONE_HOUR);`,
    enabled: true,
  },
  {
    id: 'MAINT-003',
    name: 'Deeply nested code',
    category: 'maintainability',
    severity: 'medium',
    patterns: [], // Handled by AST analysis
    description: 'Code has deep nesting (3+ levels). Use early returns or extract functions.',
    badExample: `if (a) {\n  if (b) {\n    if (c) {\n      // deep nesting\n    }\n  }\n}`,
    goodExample: `if (!a) return;\nif (!b) return;\nif (!c) return;\n// flat code`,
    enabled: true,
  },
  {
    id: 'MAINT-004',
    name: 'Commented-out code',
    category: 'maintainability',
    severity: 'low',
    patterns: [
      /^\s*\/\/\s*(function|if|for|while|const|let|var|return|class|import|export)\b/m,
    ],
    description: 'Commented-out code detected. Remove unused code instead of commenting it out.',
    badExample: `// function oldHandler() { ... }`,
    goodExample: `// (removed old handler - see commit abc123 for history)`,
    enabled: true,
  },
  {
    id: 'MAINT-005',
    name: 'Missing error handling in async operations',
    category: 'maintainability',
    severity: 'medium',
    patterns: [], // Context-dependent
    description: 'Async operations without explicit error handling can lead to unhandled rejections.',
    badExample: `async function getData() {\n  const res = await fetch(url);\n  return res.json();\n}`,
    goodExample: `async function getData() {\n  const res = await fetch(url);\n  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);\n  return res.json();\n}`,
    enabled: true,
  },
];

/**
 * Get active rules based on configuration.
 */
export function getActiveRules(
  enabledCategories: Record<RiskCategory, boolean>,
  customRules: ReviewRule[] = [],
): ReviewRule[] {
  const allRules = [...BUILT_IN_RULES, ...customRules];

  return allRules.filter((rule) => {
    if (!rule.enabled) return false;
    return enabledCategories[rule.category] !== false;
  });
}

/**
 * Static pattern matching against code text.
 * Returns matched rules for pre-filtering before LLM analysis.
 */
export function matchRules(
  code: string,
  rules: ReviewRule[],
): ReviewRule[] {
  return rules.filter((rule) => {
    if (rule.patterns.length === 0) return false;
    return rule.patterns.some((pattern) => pattern.test(code));
  });
}

/**
 * Merge custom rules defined by the user/team.
 */
export function mergeCustomRules(
  baseRules: ReviewRule[],
  customRules: ReviewRule[],
): ReviewRule[] {
  const customIds = new Set(customRules.map((r) => r.id));
  const merged = baseRules.filter((r) => !customIds.has(r.id));
  return [...merged, ...customRules];
}
