// Every behaviour of the fake partner is a knob, changed at runtime with
// POST /admin/config {"latencyMs": 100, "rateLimitRps": 20}. Only the keys you send change.
import client from 'prom-client';
import { registry } from '@lab/node-common';

export type Pricing = { input: number; output: number }; // USD per 1M tokens

export const defaults = {
  // Applied to every partner route (not /admin, /health, /metrics).
  latencyMs: 50, // typical response time, ±20% jitter
  p99LatencyMs: 50, // 1% of requests take this long instead (set above latencyMs for a slow tail)
  rateLimitRps: 0, // 0 = unlimited; above it: 429 + Retry-After
  failureRate: 0, // fraction of requests that return 500
  down: false as false | '503' | 'hang', // '503' = fail everything, 'hang' = never respond
  slowTenants: {} as Record<string, number>, // extra latency per tenant (x-tenant-id header or ?tenant=)

  // GET /customers list endpoint over a deterministic fake dataset.
  customersTotal: 1_000_000,
  customersListRps: 2, // own limit for the list endpoint, on top of rateLimitRps
  customersMaxPageSize: 250,
  customerUpdatesPerMinute: 0, // background edits, so incremental `updated_since` syncs find changes

  // Signed webhooks sent to your app.
  webhookTarget: '', // e.g. http://host.docker.internal:3000/webhooks/partner
  webhooksPerMinute: 0,
  duplicateRate: 0, // fraction of events delivered twice
  outOfOrderRate: 0, // fraction of events held back 2-5 s so later updates overtake them
  webhookTenants: 20,
  webhookActiveOrders: 200, // open orders receiving updates; fewer = more updates per order
  webhookTimeoutMs: 5_000, // your handler must answer within this or the partner retries
  webhookMaxRetries: 3, // retries after 1 s, 2 s, 4 s, ...

  // Fake LLM / embedding provider (/v1/chat/completions, /v1/embeddings).
  llmTtftMs: 800, // time to first token
  llmLatencyMs: 4_000, // total time for a full answer ("mini"/"small" models take 40% of it)
  llmTokensPerMinute: 0, // 0 = unlimited; shared by chat and embeddings, 429 above it
  embeddingLatencyMs: 200,
  embeddingDims: 384,
  embeddingMaxBatch: 100,
  pricing: {
    large: { input: 3, output: 15 },
    small: { input: 0.25, output: 1.25 },
    embedding: { input: 0.02, output: 0 },
  } as Record<string, Pricing>,
};

export type Config = typeof defaults;

export const config: Config = structuredClone(defaults);

export function updateConfig(patch: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaults)) {
      errors.push(`unknown key "${key}"`);
      continue;
    }
    const current = (defaults as Record<string, unknown>)[key];
    if (key === 'down') {
      if (value === true) patch.down = '503';
      else if (value !== false && value !== '503' && value !== 'hang') errors.push('down must be false, true, "503" or "hang"');
    } else if (typeof current === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) errors.push(`${key} must be an object`);
    } else if (typeof value !== typeof current) {
      errors.push(`${key} must be a ${typeof current}`);
    } else if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      errors.push(`${key} must be a non-negative number`);
    }
  }
  if (errors.length === 0) Object.assign(config, patch);
  return errors;
}

export function resetConfig() {
  Object.assign(config, structuredClone(defaults));
}

export const injected = new client.Counter({
  name: 'partner_injected_faults_total',
  help: 'Faults the fake partner injected on purpose',
  labelNames: ['kind'],
  registers: [registry],
});

export const stats = {
  requests: 0,
  injected: { rateLimited: 0, failed: 0, unavailable: 0, hung: 0 },
};

export function resetStats() {
  stats.requests = 0;
  stats.injected = { rateLimited: 0, failed: 0, unavailable: 0, hung: 0 };
}
