/**
 * Per-call overhead of the middleware, measured two ways.
 *
 * 1. Handler level: the wrapped handler is called directly, the way the SDK
 *    calls it, so the number is the middleware's own cost and nothing else.
 * 2. Through the SDK: a real `Client` calls a real `McpServer` over the
 *    in-memory transport, so the number includes JSON-RPC, zod validation and
 *    the SDK's dispatch, which is what a tool call actually pays.
 *
 * Every case is warmed up first. Then each round times every case once, in
 * turn, so thermal or turbo drift on the host lands on all cases alike rather
 * than on whichever ran last. The tables report each case's median round.
 * Run with `npm run bench` after `npm run build`.
 */

import { createHmac } from "node:crypto";
import { cpus, platform, release } from "node:os";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { withAuth } from "@mcp-toolkit/auth";
import { withCache } from "@mcp-toolkit/cache";
import { withCors } from "@mcp-toolkit/cors";
import { withRateLimit } from "@mcp-toolkit/rate-limit";

const ROUNDS = 15;
const API_KEY = "bench-key";
const JWT_SECRET = "bench-secret";
const ORIGIN = "https://claude.ai";

type Handler = (...args: unknown[]) => unknown;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

interface Case {
  label: string;
  fn: (i: number) => unknown;
  rounds: number[];
}

/**
 * Warm every case up, then run ROUNDS rounds of `iterations` calls per case,
 * interleaved, and return the median nanoseconds per call of each case.
 */
async function measure(cases: Case[], iterations: number): Promise<Map<string, number>> {
  for (const c of cases) {
    for (let i = 0; i < iterations; i++) await c.fn(i);
  }
  for (let r = 0; r < ROUNDS; r++) {
    for (const c of cases) {
      const offset = (r + 1) * iterations;
      const start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) await c.fn(offset + i);
      c.rounds.push(Number(process.hrtime.bigint() - start) / iterations);
    }
  }
  return new Map(cases.map((c) => [c.label, median(c.rounds)]));
}

function jwt(): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: "bench-user" })}`;
  const sig = createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// 1. Handler level
// ---------------------------------------------------------------------------

type Layer = "cors" | "auth-api-key" | "auth-jwt" | "rate-limit" | "cache";

/** Register one tool on a capture-only server and return its wrapped handler. */
function wrappedHandler(layers: Layer[]): Handler {
  let captured: Handler | undefined;
  const server = {
    tool: (...args: unknown[]) => void (captured = args[args.length - 1] as Handler),
    registerTool: (...args: unknown[]) => void (captured = args[args.length - 1] as Handler),
  };
  for (const layer of layers) {
    if (layer === "cors") withCors(server, { allowedOrigins: [ORIGIN] });
    if (layer === "auth-api-key") withAuth(server, { type: "api-key", keys: [API_KEY] });
    if (layer === "auth-jwt") withAuth(server, { type: "jwt", secret: JWT_SECRET });
    if (layer === "rate-limit") {
      withRateLimit(server, { strategy: "token-bucket", maxTokens: 1e12, refillRate: 1e12 });
    }
    if (layer === "cache") withCache(server, { strategy: "lru", ttl: 300, maxSize: 1000 });
  }
  server.registerTool("echo", {}, async (params: { q: string }) => ({
    content: [{ type: "text", text: params.q }],
  }));
  return captured!;
}

const token = jwt();
const extra = {
  requestInfo: {
    headers: { origin: ORIGIN, "x-api-key": API_KEY, authorization: `Bearer ${token}` },
  },
};

const handlerCases: Array<{ label: string; layers: Layer[]; distinctArgs: boolean }> = [
  { label: "bare handler (baseline)", layers: [], distinctArgs: true },
  { label: "cors", layers: ["cors"], distinctArgs: true },
  { label: "auth (api-key)", layers: ["auth-api-key"], distinctArgs: true },
  { label: "auth (jwt HS256)", layers: ["auth-jwt"], distinctArgs: true },
  { label: "rate-limit", layers: ["rate-limit"], distinctArgs: true },
  { label: "cache, every call a miss", layers: ["cache"], distinctArgs: true },
  { label: "cache, every call a hit", layers: ["cache"], distinctArgs: false },
  {
    label: "cors + auth (api-key) + rate-limit + cache (miss)",
    layers: ["cors", "auth-api-key", "rate-limit", "cache"],
    distinctArgs: true,
  },
  {
    label: "cors + auth (jwt) + rate-limit + cache (miss)",
    layers: ["cors", "auth-jwt", "rate-limit", "cache"],
    distinctArgs: true,
  },
];

// ---------------------------------------------------------------------------
// 2. Through the SDK
// ---------------------------------------------------------------------------

async function sdkClient(stacked: boolean): Promise<Client> {
  const server = new McpServer({ name: "bench", version: "1.0.0" });
  if (stacked) {
    // stdio-style stack: no cors (no Origin exists in memory), key in _meta.
    withAuth(server, { type: "api-key", keys: [API_KEY] });
    withRateLimit(server, { strategy: "token-bucket", maxTokens: 1e12, refillRate: 1e12 });
    withCache(server, { strategy: "lru", ttl: 300, maxSize: 1000 });
  }
  server.registerTool("echo", { inputSchema: { q: z.string() } }, async ({ q }) => ({
    content: [{ type: "text" as const, text: q }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bench-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function us(ns: number): string {
  return (ns / 1000).toFixed(2);
}

async function main(): Promise<void> {
  const cpu = cpus()[0]?.model.trim() ?? "unknown CPU";
  console.log(`Node ${process.version}, ${platform()} ${release()}, ${cpu}`);
  console.log(`Median of ${ROUNDS} rounds.\n`);

  const handlerIterations = 50_000;
  console.log(`Handler level (middleware cost only, ${handlerIterations.toLocaleString("en-US")} calls per round)
`);
  const handlerResults = await measure(
    handlerCases.map((c) => {
      const handler = wrappedHandler(c.layers);
      return {
        label: c.label,
        fn: (i: number) => handler({ q: c.distinctArgs ? `q${i}` : "same" }, extra),
        rounds: [],
      };
    }),
    handlerIterations,
  );
  console.log("| Layers | us per call | Added over baseline (us) |");
  console.log("|--------|------------:|-------------------------:|");
  const baseline = handlerResults.get(handlerCases[0]!.label)!;
  for (const c of handlerCases) {
    const ns = handlerResults.get(c.label)!;
    const added = c.layers.length === 0 ? "-" : us(ns - baseline);
    console.log(`| ${c.label} | ${us(ns)} | ${added} |`);
  }

  const sdkIterations = 2_000;
  console.log(
    `
Through the SDK (Client -> McpServer over InMemoryTransport, ${sdkIterations.toLocaleString("en-US")} calls per round)
`,
  );
  const bare = await sdkClient(false);
  const stacked = await sdkClient(true);
  const meta = { "x-api-key": API_KEY };
  const sdkCases: Case[] = [
    {
      label: "bare McpServer",
      fn: (i) => bare.callTool({ name: "echo", arguments: { q: `q${i}` } }),
      rounds: [],
    },
    {
      label: "auth + rate-limit + cache, cache miss",
      fn: (i) => stacked.callTool({ name: "echo", arguments: { q: `q${i}` }, _meta: meta }),
      rounds: [],
    },
    {
      label: "auth + rate-limit + cache, cache hit",
      fn: () => stacked.callTool({ name: "echo", arguments: { q: "same" }, _meta: meta }),
      rounds: [],
    },
  ];
  const sdkResults = await measure(sdkCases, sdkIterations);
  console.log("| Server | us per tools/call | Added (us) |");
  console.log("|--------|------------------:|-----------:|");
  const bareNs = sdkResults.get("bare McpServer")!;
  for (const c of sdkCases) {
    const ns = sdkResults.get(c.label)!;
    console.log(`| ${c.label} | ${us(ns)} | ${c === sdkCases[0] ? "-" : us(ns - bareNs)} |`);
  }
  await Promise.all([bare.close(), stacked.close()]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
