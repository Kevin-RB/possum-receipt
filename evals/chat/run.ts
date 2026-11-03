import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { LM_STUDIO_URL, CHAT_MODEL } from "@/lib/ai/provider";
import type { ChatAgent } from "@/lib/chat/agent";
import { createChatAgent } from "@/lib/chat/agent";
import { db } from "@/lib/db";
import { FIXTURE_EMAIL } from "@/lib/db/fixture";
import { user } from "@/lib/db/schema/auth";
import { DEFAULT_TIMEZONE, resolveToday } from "@/lib/time";

import type {
  Check,
  CheckResult,
  Observation,
  Scenario,
  ToolCall,
} from "./scenarios";
import { describeToolCalls, scenarios } from "./scenarios";

/**
 * Real-model chat evals. Unlike `pnpm test`, this needs Postgres (for the
 * fixture owner) and LM Studio, so it is never part of CI. Each scenario runs
 * several times because the local model is flaky: the output is a pass rate,
 * not a single verdict.
 */

/** Runs per scenario. Enough to see flakiness, small enough to finish quickly. */
const RUNS_PER_SCENARIO = 3;

const RESULTS_PATH = path.join(
  import.meta.dirname,
  "..",
  "results",
  "latest.json"
);

type CheckRecord = CheckResult & Pick<Check, "expected" | "kind">;

type ScenarioCheck = Pick<Check, "expected" | "kind">;

interface RunRecord {
  answer: string;
  checks: CheckRecord[];
  error?: string;
  latencyMs: number;
  steps: number;
  tools: Pick<ToolCall, "input" | "name">[];
}

interface ScenarioRecord {
  checks: ScenarioCheck[];
  name: string;
  passRate: string;
  prompt: string;
  runs: RunRecord[];
}

const runPassed = (run: RunRecord): boolean =>
  run.checks.every((check) => check.ok);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runOnce = async (
  agent: ChatAgent,
  scenario: Scenario
): Promise<RunRecord> => {
  const startedAt = Date.now();

  try {
    const result = await agent.generate({ prompt: scenario.prompt });
    const latencyMs = Date.now() - startedAt;
    const outputs = new Map(
      result.steps
        .flatMap((step) => step.toolResults)
        .map((toolResult) => [toolResult.toolCallId, toolResult.output])
    );
    const observation: Observation = {
      answer: result.text,
      steps: result.steps.length,
      tools: result.steps
        .flatMap((step) => step.toolCalls)
        .map((toolCall) => ({
          input: toolCall.input as Record<string, unknown>,
          name: toolCall.toolName,
          output: outputs.get(toolCall.toolCallId),
        })),
    };

    return {
      answer: observation.answer,
      checks: scenario.checks.map((check) => ({
        ...check.run(observation),
        expected: check.expected,
        kind: check.kind,
      })),
      latencyMs,
      steps: observation.steps,
      // The full tool output is only needed while checking a run; keeping it
      // in latest.json would turn a small diff file into a copy of the corpus.
      tools: observation.tools.map(({ input, name }) => ({ input, name })),
    };
  } catch (error) {
    return {
      answer: "",
      checks: scenario.checks.map((check) => ({
        actual: `error: ${errorMessage(error)}`,
        expected: check.expected,
        kind: check.kind,
        ok: false,
      })),
      error: errorMessage(error),
      latencyMs: Date.now() - startedAt,
      steps: 0,
      tools: [],
    };
  }
};

const runScenario = async (
  agent: ChatAgent,
  scenario: Scenario
): Promise<ScenarioRecord> => {
  const runs: RunRecord[] = [];
  for (let run = 0; run < RUNS_PER_SCENARIO; run += 1) {
    // Sequential on purpose: one local model serves the requests, so
    // concurrent runs would contend for it and muddy the latency column.
    // eslint-disable-next-line no-await-in-loop
    runs.push(await runOnce(agent, scenario));
  }

  const passed = runs.filter((run) => runPassed(run)).length;

  return {
    checks: scenario.checks.map((check) => ({
      expected: check.expected,
      kind: check.kind,
    })),
    name: scenario.name,
    passRate: `${passed}/${RUNS_PER_SCENARIO}`,
    prompt: scenario.prompt,
    runs,
  };
};

/** The same tool calls in every run are shown once; a difference is numbered. */
const actualTools = (runs: RunRecord[]): string => {
  const described = runs.map((run) =>
    run.error ? `error: ${run.error}` : describeToolCalls(run.tools)
  );
  const unique = [...new Set(described)];
  return unique.length === 1
    ? unique[0]
    : described.map((value, index) => `${index + 1}: ${value}`).join(" | ");
};

/**
 * Fixed-width table. Nothing is truncated: the arguments are the point, and a
 * failing run is expanded in full below.
 */
const printTable = (headers: string[], rows: string[][]) => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );
  const render = (row: string[]) =>
    row.map((value, index) => value.padEnd(widths[index])).join("  ");

  console.log(render(headers));
  console.log(widths.map((width) => "─".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(render(row));
  }
};

const quoteExcerpt = (value: string): string => {
  const excerpt = value.length <= 240 ? value : `${value.slice(0, 239)}…`;
  return JSON.stringify(excerpt);
};

const printReport = (records: ScenarioRecord[]) => {
  const rows = records.map((record) => [
    record.name,
    record.passRate,
    record.checks.map((check) => check.expected).join("; "),
    actualTools(record.runs),
    record.runs.map((run) => run.steps).join("/"),
    `${Math.round(
      record.runs.reduce((sum, run) => sum + run.latencyMs, 0) /
        record.runs.length
    )}ms`,
  ]);

  printTable(
    ["scenario", "pass", "expected", "actual tools", "steps", "latency"],
    rows
  );

  const failures = records.flatMap((record) =>
    record.runs
      .map((run, index) => ({ index, run }))
      .filter(({ run }) => !runPassed(run))
      .map(({ index, run }) => ({ index, record, run }))
  );

  if (failures.length === 0) {
    console.log("\nEvery run passed.");
    return;
  }

  console.log("\nFailures:");
  let previousPrompt: string | null = null;
  for (const { index, record, run } of failures) {
    if (record.prompt !== previousPrompt) {
      console.log(`\n${record.prompt}`);
      previousPrompt = record.prompt;
    }
    console.log(
      `  run ${index + 1}: ${run.error ?? `${run.steps} steps, ${run.latencyMs}ms`}`
    );
    for (const check of run.checks) {
      if (check.ok) {
        continue;
      }
      console.log(
        `    ${check.kind}: expected ${check.expected}; actual ${check.actual}`
      );
    }
    console.log(`    tools:  ${describeToolCalls(run.tools)}`);
    console.log(`    answer: ${quoteExcerpt(run.answer)}`);
  }
};

const resolveOwnerId = async (): Promise<string> => {
  const [owner] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, FIXTURE_EMAIL))
    .limit(1);

  if (!owner) {
    throw new Error(
      `No user ${FIXTURE_EMAIL}. Run \`pnpm db:fixture --apply\` first.`
    );
  }
  return owner.id;
};

const main = async () => {
  const ownerId = await resolveOwnerId();
  // No viewer behind an eval run, so the agent gets the same fallback zone the
  // scenarios' date expectations are built from.
  const agent = await createChatAgent(
    ownerId,
    resolveToday(DEFAULT_TIMEZONE),
    DEFAULT_TIMEZONE
  );

  console.log(
    `Chat evals: ${scenarios.length} scenarios x ${RUNS_PER_SCENARIO} runs`
  );
  console.log(`  model:  ${CHAT_MODEL} (${LM_STUDIO_URL})`);
  console.log(`  owner:  ${FIXTURE_EMAIL}`);
  console.log("");

  const records: ScenarioRecord[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.name} … `);
    // eslint-disable-next-line no-await-in-loop
    const record = await runScenario(agent, scenario);
    records.push(record);
    console.log(record.passRate);
  }

  console.log("");
  printReport(records);

  const totalRuns = records.length * RUNS_PER_SCENARIO;
  const passedRuns = records.reduce(
    (sum, record) => sum + record.runs.filter((run) => runPassed(run)).length,
    0
  );
  console.log(
    `\nOverall: ${passedRuns}/${totalRuns} runs passed (${Math.round((passedRuns / totalRuns) * 100)}%)`
  );
  await mkdir(path.dirname(RESULTS_PATH), { recursive: true });
  await writeFile(
    RESULTS_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: CHAT_MODEL,
        owner: FIXTURE_EMAIL,
        runsPerScenario: RUNS_PER_SCENARIO,
        scenarios: records,
      },
      null,
      2
    )}\n`
  );
  console.log(`Wrote ${RESULTS_PATH}`);
};

try {
  await main();
} finally {
  await db.$client.end();
}
