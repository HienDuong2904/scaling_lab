// A fake LLM and embedding provider with an OpenAI-style request shape, slow answers, a
// shared tokens-per-minute limit and a cost counter. Pass x-tenant-id to see cost per tenant.
// Models with "mini" or "small" in the name are faster and cheaper (for model routing).
import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import client from 'prom-client';
import { registry, sleep } from '@lab/node-common';
import { config, type Pricing } from './config.ts';
import { TokenBucket, rejectRateLimited, tenantOf } from './chaos.ts';
import { seeded } from './customers.ts';

const WORDS = 'the order customer tenant queue retry cache index replica latency throughput batch stream partition cursor lock token budget shard worker answer source chunk document vector'.split(' ');

const tokenCounter = new client.Counter({
  name: 'partner_llm_tokens_total',
  help: 'Tokens processed by the fake LLM provider',
  labelNames: ['kind', 'model'],
  registers: [registry],
});
const costCounter = new client.Counter({
  name: 'partner_llm_cost_usd_total',
  help: 'What the fake LLM provider would have billed',
  labelNames: ['model', 'tenant'],
  registers: [registry],
});

type Usage = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
export const llmStats = { total: emptyUsage(), byModel: {} as Record<string, Usage>, byTenant: {} as Record<string, Usage> };

export function resetLlm() {
  llmStats.total = emptyUsage();
  llmStats.byModel = {};
  llmStats.byTenant = {};
}

const tokens = (text: string) => Math.ceil(text.length / 4);
const isSmall = (model: string) => /mini|small/i.test(model);
const tpmBucket = new TokenBucket();

function priceFor(model: string, kind: 'chat' | 'embedding'): Pricing {
  if (kind === 'embedding') return config.pricing.embedding ?? { input: 0, output: 0 };
  return config.pricing[model] ?? (isSmall(model) ? config.pricing.small : config.pricing.large) ?? { input: 0, output: 0 };
}

function record(req: Request, model: string, kind: 'chat' | 'embedding', input: number, output: number) {
  const price = priceFor(model, kind);
  const cost = (input * price.input + output * price.output) / 1_000_000;
  const tenant = tenantOf(req) ?? 'none';
  for (const usage of [llmStats.total, (llmStats.byModel[model] ??= emptyUsage()), (llmStats.byTenant[tenant] ??= emptyUsage())]) {
    usage.calls++;
    usage.inputTokens += input;
    usage.outputTokens += output;
    usage.costUsd += cost;
  }
  tokenCounter.inc({ kind: 'input', model }, input);
  if (output) tokenCounter.inc({ kind: 'output', model }, output);
  costCounter.inc({ model, tenant }, cost);
}

// Returns false (and has answered 429) when the request would exceed tokens per minute.
function withinTpm(res: Response, cost: number): boolean {
  if (config.llmTokensPerMinute <= 0) return true;
  const wait = tpmBucket.take(config.llmTokensPerMinute / 60, config.llmTokensPerMinute, cost);
  if (wait === 0) return true;
  if (wait === Infinity) {
    res.status(400).json({ error: 'request_too_large', detail: `needs ${cost} tokens, limit is ${config.llmTokensPerMinute}/min` });
    return false;
  }
  rejectRateLimited(res, wait);
  return false;
}

function hashSeed(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

function embed(text: string): number[] {
  const rand = seeded(hashSeed(text));
  const vector = Array.from({ length: config.embeddingDims }, () => rand() * 2 - 1);
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}

export const llmRouter = Router();

llmRouter.post('/v1/embeddings', async (req, res) => {
  const model = String(req.body?.model ?? 'embed-small');
  const input = req.body?.input;
  const texts: unknown[] = Array.isArray(input) ? input : [input];
  if (texts.length === 0 || texts.some((t) => typeof t !== 'string')) return void res.status(400).json({ error: 'input must be a string or an array of strings' });
  if (texts.length > config.embeddingMaxBatch) return void res.status(400).json({ error: `at most ${config.embeddingMaxBatch} inputs per request` });
  const promptTokens = (texts as string[]).reduce((sum, t) => sum + tokens(t), 0);
  if (!withinTpm(res, promptTokens)) return;
  await sleep(config.embeddingLatencyMs);
  record(req, model, 'embedding', promptTokens, 0);
  res.json({
    object: 'list',
    model,
    data: (texts as string[]).map((text, index) => ({ object: 'embedding', index, embedding: embed(text) })),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  });
});

llmRouter.post('/v1/chat/completions', async (req, res) => {
  const model = String(req.body?.model ?? 'large');
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return void res.status(400).json({ error: 'messages must be a non-empty array' });
  const prompt = messages.map((m: { content?: unknown }) => String(m?.content ?? '')).join('\n');
  const promptTokens = tokens(prompt);
  const maxTokens = Math.max(1, Number(req.body?.max_tokens ?? 256) || 256);
  const rand = seeded(hashSeed(`${model}:${prompt}`));
  const words = Array.from({ length: Math.min(maxTokens, 40 + Math.floor(rand() * 160)) }, () => WORDS[Math.floor(rand() * WORDS.length)]);
  const completionTokens = words.length;
  if (!withinTpm(res, promptTokens + completionTokens)) return;

  const speed = isSmall(model) ? 0.4 : 1;
  const ttft = config.llmTtftMs * speed;
  const total = Math.max(ttft, config.llmLatencyMs * speed);
  const id = `chatcmpl_${hashSeed(prompt + Date.now()).toString(36)}`;
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };

  if (!req.body?.stream) {
    await sleep(total);
    record(req, model, 'chat', promptTokens, completionTokens);
    res.json({
      id,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: `[fake answer] ${words.join(' ')}` }, finish_reason: 'stop' }],
      usage,
    });
    return;
  }

  // Server-Sent Events: first token after ttft, the rest spread over the remaining time.
  let closed = false;
  res.on('close', () => (closed = true));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  await sleep(ttft);
  const gap = (total - ttft) / completionTokens;
  const chunk = (delta: object, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant', content: '[fake answer]' });
  let sent = 0;
  for (const word of words) {
    if (closed) break;
    chunk({ content: ` ${word}` });
    sent++;
    await sleep(gap);
  }
  // Billed for what was generated, like a real provider when the client disconnects early.
  record(req, model, 'chat', promptTokens, sent);
  if (closed) return;
  chunk({}, 'stop');
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
});
