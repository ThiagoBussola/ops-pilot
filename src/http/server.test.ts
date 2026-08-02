import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";

import { createRegistry, listStrategies, resolveStrategy } from "../agents/index.js";
import type { ReasoningStrategy, StrategyResult } from "../domain/types.js";
import type { CritiqueResult } from "../strategies/reflect.js";
import { createApp } from "./server.js";

function fakeStrategy(overrides?: {
  name?: string;
  delayMs?: number;
  run?: (input: string) => Promise<StrategyResult>;
}): ReasoningStrategy & { calls: number; inputs: string[] } {
  const strategy: ReasoningStrategy & { calls: number; inputs: string[] } = {
    name: overrides?.name ?? "fake",
    calls: 0,
    inputs: [],
    async run(input: string): Promise<StrategyResult> {
      strategy.calls += 1;
      strategy.inputs.push(input);
      if (overrides?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, overrides.delayMs));
      }
      if (overrides?.run) {
        return overrides.run(input);
      }
      return {
        answer: `echo:${input}`,
        trace: [{ type: "answer", content: `echo:${input}` }],
        metrics: { llmCalls: 1, latencyMs: 1 },
      };
    },
  };
  return strategy;
}

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind ephemeral port");
    }
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postChat(
  baseUrl: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

test("US1: POST /chat happy path with fake react strategy", async () => {
  const react = fakeStrategy({ name: "react" });
  const app = createApp({ registry: createRegistry({ react }) });

  await withServer(app, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, { message: "oi" });
    assert.equal(status, 200);
    assert.equal(json.answer, "echo:oi");
    assert.ok(Array.isArray(json.trace));
    assert.ok(json.metrics && typeof json.metrics === "object");
    const metrics = json.metrics as { llmCalls: number; latencyMs: number };
    assert.equal(metrics.llmCalls, 1);
    assert.equal(typeof metrics.latencyMs, "number");
    assert.equal(react.calls, 1);
  });
});

test("US1: explicit strategy selects registry entry", async () => {
  const react = fakeStrategy({ name: "react" });
  const other = fakeStrategy({ name: "other" });
  const app = createApp({
    registry: createRegistry({ react, other }),
  });

  await withServer(app, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      message: "ping",
      strategy: "other",
    });
    assert.equal(status, 200);
    assert.equal(json.answer, "echo:ping");
    assert.equal(other.calls, 1);
    assert.equal(react.calls, 0);
  });
});

test("US1: reflect true with approving critic adds critique overhead", async () => {
  const react = fakeStrategy({ name: "react" });
  const criticCalls: number[] = [];
  const app = createApp({
    registry: createRegistry({ react }),
    reflectionOpts: {
      critic: async (): Promise<CritiqueResult> => {
        criticCalls.push(1);
        return { approved: true, feedback: "" };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      message: "com reflect",
      reflect: true,
    });
    assert.equal(status, 200);
    assert.equal(react.calls, 1);
    assert.equal(criticCalls.length, 1);
    const metrics = json.metrics as { llmCalls: number };
    assert.equal(metrics.llmCalls, 2);
    const trace = json.trace as Array<{ type: string; approved?: boolean }>;
    assert.ok(trace.some((event) => event.type === "critique" && event.approved === true));
  });
});

test("US2: invalid body returns 400 with zod issues", async () => {
  const react = fakeStrategy({ name: "react" });
  const app = createApp({ registry: createRegistry({ react }) });

  await withServer(app, async (baseUrl) => {
    const wrongField = await postChat(baseUrl, { mensagem: "campo errado" });
    assert.equal(wrongField.status, 400);
    assert.equal(wrongField.json.error, "validation_error");
    assert.ok(Array.isArray(wrongField.json.issues));
    assert.equal(react.calls, 0);

    const emptyMessage = await postChat(baseUrl, { message: "" });
    assert.equal(emptyMessage.status, 400);
    assert.equal(emptyMessage.json.error, "validation_error");
    assert.equal(react.calls, 0);
  });
});

test("US2: unknown strategy returns 422", async () => {
  const react = fakeStrategy({ name: "react" });
  const app = createApp({ registry: createRegistry({ react }) });

  await withServer(app, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      message: "ok",
      strategy: "nope",
    });
    assert.equal(status, 422);
    assert.equal(json.error, "unknown_strategy");
    assert.equal(json.strategy, "nope");
    assert.equal(react.calls, 0);
  });
});

test("US2: omitted strategy and reflect default to react without reflection", async () => {
  const react = fakeStrategy({ name: "react" });
  const app = createApp({ registry: createRegistry({ react }) });

  await withServer(app, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, { message: "defaults" });
    assert.equal(status, 200);
    assert.equal(json.answer, "echo:defaults");
    assert.equal(react.calls, 1);
    const metrics = json.metrics as { llmCalls: number };
    assert.equal(metrics.llmCalls, 1);
    const trace = json.trace as Array<{ type: string }>;
    assert.ok(!trace.some((event) => event.type === "critique"));
  });
});

test("US3: slow strategy exceeds injected timeout -> 504", async () => {
  const react = fakeStrategy({ name: "react", delayMs: 80 });
  const app = createApp({
    registry: createRegistry({ react }),
    timeoutMs: 20,
  });

  await withServer(app, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, { message: "slow" });
    assert.equal(status, 504);
    assert.equal(json.error, "timeout");
    assert.match(String(json.message), /timed out/i);
  });
});

test("US3: fast strategy returns 200 under timeout", async () => {
  const react = fakeStrategy({ name: "react" });
  const app = createApp({
    registry: createRegistry({ react }),
    timeoutMs: 5_000,
  });

  await withServer(app, async (baseUrl) => {
    const { status } = await postChat(baseUrl, { message: "fast" });
    assert.equal(status, 200);
  });
});

test("US4: custom-named fake-only registry works end-to-end", async () => {
  const custom = fakeStrategy({ name: "custom-ops" });
  const app = createApp({
    registry: createRegistry({ "custom-ops": custom }),
  });

  await withServer(app, async (baseUrl) => {
    const { status, json } = await postChat(baseUrl, {
      message: "extensível",
      strategy: "custom-ops",
    });
    assert.equal(status, 200);
    assert.equal(json.answer, "echo:extensível");
    assert.equal(custom.calls, 1);
    assert.deepEqual(listStrategies(createRegistry({ "custom-ops": custom })), [
      "custom-ops",
    ]);
  });
});

test("US4: resolveStrategy with reflect returns reflect: name", () => {
  const base = fakeStrategy({ name: "react" });
  const registry = createRegistry({ react: base });
  const resolved = resolveStrategy(registry, "react", true, {
    critic: async () => ({ approved: true, feedback: "" }),
  });
  assert.equal(resolved.name, "reflect:react");
});

test("POST /chat accepts curl-style body without application/json Content-Type", async () => {
  const react = fakeStrategy({ name: "react" });
  const app = createApp({ registry: createRegistry({ react }) });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: '{"message":"quais incidentes estão abertos?"}',
    });
    const json = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(json.answer, "echo:quais incidentes estão abertos?");
  });
});
