// Phase 4: Standardized Aider Refactoring Benchmark. See spec section 5 and
// user stories 9-10. Seeds an isolated git workspace with a 15-problem
// polyglot refactoring slice, runs `aider` headlessly against it under a
// 15-minute cap, then grades each problem's self-check and re-measures decode
// throughput to approximate thermal/driver decay after a sustained agentic run.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LmStudioClient } from "../apiClient";
import type { CommandRunner } from "../subprocess";
import type { BenchmarkMetrics, ModelConfig } from "../types";

export const AIDER_TIMEOUT_MS = 15 * 60 * 1000;
export const MINI_SUBSET_SIZE = 15;
const PING_PROMPT = "Reply with a short greeting.";
const PING_MAX_TOKENS = 10;

const SYNTAX_ERROR_PATTERNS = [
  /SyntaxError/i,
  /Unexpected token/i,
  /error\[E\d+\]/, // rustc
  /IndentationError/i,
  /ParseError/i,
  /expected .* found/i, // go/rustc parse errors
];

export function detectSyntaxError(output: string): boolean {
  return SYNTAX_ERROR_PATTERNS.some((re) => re.test(output));
}

export function sanitizeWorkspaceName(modelKey: string): string {
  return modelKey.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export interface PolyglotProblem {
  id: string;
  language: string;
  fileName: string;
  buggyCode: string;
  instructions: string;
  testCommand: string[];
}

interface LanguageConfig {
  key: string;
  ext: string;
  testCommand: (fileName: string) => string[];
}

const LANGUAGES: LanguageConfig[] = [
  { key: "typescript", ext: "ts", testCommand: (f) => ["bun", "run", f] },
  { key: "javascript", ext: "js", testCommand: (f) => ["bun", "run", f] },
  { key: "python", ext: "py", testCommand: (f) => ["python3", f] },
  { key: "go", ext: "go", testCommand: (f) => ["go", "run", f] },
  {
    key: "rust",
    ext: "rs",
    testCommand: (f) => ["bash", "-c", `rustc -O -o "${f}.bin" "${f}" && "${f}.bin"`],
  },
];

interface Template {
  key: string;
  instructions: string;
  source: Record<string, string>; // language key -> source code
}

const TEMPLATES: Template[] = [
  {
    key: "sum-range",
    instructions:
      "sumRange must sum every element in the array, but the loop currently stops one index early. Fix the loop bound so all elements are included.",
    source: {
      typescript: `function sumRange(nums: number[]): number {
  let total = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    total += nums[i];
  }
  return total;
}

const result = sumRange([1, 2, 3, 4]);
if (result === 10) {
  console.log("PASS");
} else {
  console.error(\`FAIL: expected 10 got \${result}\`);
  process.exit(1);
}
`,
      javascript: `function sumRange(nums) {
  let total = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    total += nums[i];
  }
  return total;
}

const result = sumRange([1, 2, 3, 4]);
if (result === 10) {
  console.log("PASS");
} else {
  console.error(\`FAIL: expected 10 got \${result}\`);
  process.exit(1);
}
`,
      python: `def sum_range(nums):
    total = 0
    for i in range(len(nums) - 1):
        total += nums[i]
    return total


result = sum_range([1, 2, 3, 4])
if result == 10:
    print("PASS")
else:
    print(f"FAIL: expected 10 got {result}")
    exit(1)
`,
      go: `package main

import (
	"fmt"
	"os"
)

func sumRange(nums []int) int {
	total := 0
	for i := 0; i < len(nums)-1; i++ {
		total += nums[i]
	}
	return total
}

func main() {
	result := sumRange([]int{1, 2, 3, 4})
	if result == 10 {
		fmt.Println("PASS")
	} else {
		fmt.Printf("FAIL: expected 10 got %d\\n", result)
		os.Exit(1)
	}
}
`,
      rust: `fn sum_range(nums: &[i32]) -> i32 {
    let mut total = 0;
    for i in 0..nums.len() - 1 {
        total += nums[i];
    }
    total
}

fn main() {
    let result = sum_range(&[1, 2, 3, 4]);
    if result == 10 {
        println!("PASS");
    } else {
        println!("FAIL: expected 10 got {}", result);
        std::process::exit(1);
    }
}
`,
    },
  },
  {
    key: "is-adult",
    instructions:
      "isAdult must return true when age is exactly 18 (the legal adult threshold), but currently only returns true when age is strictly greater than 18. Fix the comparison.",
    source: {
      typescript: `function isAdult(age: number): boolean {
  return age > 18;
}

const result = isAdult(18);
if (result === true) {
  console.log("PASS");
} else {
  console.error(\`FAIL: expected true got \${result}\`);
  process.exit(1);
}
`,
      javascript: `function isAdult(age) {
  return age > 18;
}

const result = isAdult(18);
if (result === true) {
  console.log("PASS");
} else {
  console.error(\`FAIL: expected true got \${result}\`);
  process.exit(1);
}
`,
      python: `def is_adult(age):
    return age > 18


result = is_adult(18)
if result is True:
    print("PASS")
else:
    print(f"FAIL: expected True got {result}")
    exit(1)
`,
      go: `package main

import (
	"fmt"
	"os"
)

func isAdult(age int) bool {
	return age > 18
}

func main() {
	result := isAdult(18)
	if result {
		fmt.Println("PASS")
	} else {
		fmt.Printf("FAIL: expected true got %v\\n", result)
		os.Exit(1)
	}
}
`,
      rust: `fn is_adult(age: u32) -> bool {
    age > 18
}

fn main() {
    let result = is_adult(18);
    if result {
        println!("PASS");
    } else {
        println!("FAIL: expected true got {}", result);
        std::process::exit(1);
    }
}
`,
    },
  },
  {
    key: "safe-divide",
    instructions:
      "safeDivide must return 0 when the divisor is zero instead of dividing by zero. Add the missing zero-check.",
    source: {
      typescript: `function safeDivide(a: number, b: number): number {
  return a / b;
}

const result = safeDivide(10, 0);
if (result === 0) {
  console.log("PASS");
} else {
  console.error(\`FAIL: expected 0 got \${result}\`);
  process.exit(1);
}
`,
      javascript: `function safeDivide(a, b) {
  return a / b;
}

const result = safeDivide(10, 0);
if (result === 0) {
  console.log("PASS");
} else {
  console.error(\`FAIL: expected 0 got \${result}\`);
  process.exit(1);
}
`,
      python: `def safe_divide(a, b):
    return a / b


result = safe_divide(10, 0)
if result == 0:
    print("PASS")
else:
    print(f"FAIL: expected 0 got {result}")
    exit(1)
`,
      go: `package main

import (
	"fmt"
	"os"
)

func safeDivide(a, b int) int {
	return a / b
}

func main() {
	result := safeDivide(10, 0)
	if result == 0 {
		fmt.Println("PASS")
	} else {
		fmt.Printf("FAIL: expected 0 got %d\\n", result)
		os.Exit(1)
	}
}
`,
      rust: `fn safe_divide(a: i32, b: i32) -> i32 {
    a / b
}

fn main() {
    let result = safe_divide(10, 0);
    if result == 0 {
        println!("PASS");
    } else {
        println!("FAIL: expected 0 got {}", result);
        std::process::exit(1);
    }
}
`,
    },
  },
];

/**
 * Builds the standardized 15-problem polyglot refactoring mini-subset (5
 * languages x 3 bug templates) used in place of the full 225-problem Aider
 * polyglot benchmark (out of scope per spec — this is a 15-minute sample).
 */
export function buildMiniPolyglotSubset(): PolyglotProblem[] {
  return LANGUAGES.flatMap((lang) =>
    TEMPLATES.map((template) => {
      const fileName = `${lang.key}_${template.key.replace(/-/g, "_")}.${lang.ext}`;
      const source = template.source[lang.key];
      if (!source) throw new Error(`no fixture source for language "${lang.key}" template "${template.key}"`);
      return {
        id: `${lang.key}-${template.key}`,
        language: lang.key,
        fileName,
        buggyCode: source,
        instructions: template.instructions,
        testCommand: lang.testCommand(fileName),
      };
    }),
  );
}

export interface Phase4Deps {
  runner: CommandRunner;
  client: Pick<LmStudioClient, "completion">;
  workspaceRoot?: string;
  baseUrl?: string;
}

/** Seeds the isolated workspace directory and commits the starting state to git. */
export async function prepareWorkspace(
  runner: CommandRunner,
  workspaceDir: string,
  problems: PolyglotProblem[],
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await Promise.all(problems.map((p) => Bun.write(join(workspaceDir, p.fileName), p.buggyCode)));

  await runner.run("git", ["init"], { cwd: workspaceDir });
  await runner.run("git", ["add", "-A"], { cwd: workspaceDir });
  await runner.run("git", ["-c", "user.email=eval@local", "-c", "user.name=llm-eval-suite", "commit", "-m", "seed: mini polyglot refactor subset"], {
    cwd: workspaceDir,
  });
}

/**
 * Verified against aider's own docs (aider.chat/docs/llms/openai-compat.html,
 * aider.chat/docs/config/options.html): --openai-api-base + --model openai/<name>
 * is the correct, current, non-deprecated way to point aider at any
 * OpenAI-compatible server, including LM Studio's. --openai-api-key is
 * required even though LM Studio doesn't check it — aider's HTTP client
 * fails outright trying to send an empty Bearer token without one.
 */
export function buildAiderArgs(problems: PolyglotProblem[], baseUrl: string, modelKey: string): string[] {
  const message = [
    "Fix the bug described for each file below. Do not change anything else.",
    ...problems.map((p) => `- ${p.fileName}: ${p.instructions}`),
  ].join("\n");

  return [
    "--yes-always",
    "--no-auto-commits",
    "--openai-api-base",
    baseUrl,
    "--openai-api-key",
    "dummy-api-key",
    "--model",
    `openai/${modelKey}`,
    "--message",
    message,
    ...problems.map((p) => p.fileName),
  ];
}

async function measureDecodeSpeed(client: Pick<LmStudioClient, "completion">, modelKey: string): Promise<number> {
  const result = await client.completion({ model: modelKey, prompt: PING_PROMPT, maxTokens: PING_MAX_TOKENS });
  return result.decodeTokPerSec;
}

async function runProblemTests(
  runner: CommandRunner,
  workspaceDir: string,
  problems: PolyglotProblem[],
): Promise<{ passed: number; syntaxErrorCount: number }> {
  let passed = 0;
  let syntaxErrorCount = 0;

  for (const problem of problems) {
    const [cmd, ...args] = problem.testCommand;
    if (!cmd) continue;
    const result = await runner.run(cmd, args, { cwd: workspaceDir });
    if (result.exitCode === 0) {
      passed++;
    } else if (detectSyntaxError(`${result.stdout}\n${result.stderr}`)) {
      syntaxErrorCount++;
    }
  }

  return { passed, syntaxErrorCount };
}

export async function runPhase4(
  model: ModelConfig,
  deps: Phase4Deps,
): Promise<BenchmarkMetrics & { workspaceDir: string }> {
  const problems = buildMiniPolyglotSubset();
  const workspaceDir = join(deps.workspaceRoot ?? "./data", `workspace_${sanitizeWorkspaceName(model.modelKey)}`);
  const baseUrl = deps.baseUrl ?? "http://127.0.0.1:1234/v1";

  await prepareWorkspace(deps.runner, workspaceDir, problems);

  const preRunDecodeSpeed = await measureDecodeSpeed(deps.client, model.modelKey);

  const aiderArgs = buildAiderArgs(problems, baseUrl, model.modelKey);
  try {
    await deps.runner.run("aider", aiderArgs, { cwd: workspaceDir, timeoutMs: AIDER_TIMEOUT_MS });
  } catch (err) {
    // A run that hits the 15-minute cap is expected for slower models — grade
    // whatever aider managed to edit rather than failing the whole phase.
    if (!(err instanceof Error) || !/timed out/i.test(err.message)) throw err;
  }

  const postRunDecodeSpeed = await measureDecodeSpeed(deps.client, model.modelKey);
  const { passed, syntaxErrorCount } = await runProblemTests(deps.runner, workspaceDir, problems);

  const thermalDecayPercent =
    preRunDecodeSpeed > 0 ? Math.max(0, ((preRunDecodeSpeed - postRunDecodeSpeed) / preRunDecodeSpeed) * 100) : 0;

  return {
    modelKey: model.modelKey,
    passRatePercent: (passed / problems.length) * 100,
    syntaxErrorCount,
    avgDecodeSpeed: (preRunDecodeSpeed + postRunDecodeSpeed) / 2,
    thermalDecayPercent,
    workspaceDir,
  };
}
