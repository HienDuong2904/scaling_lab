// The middleware that makes the partner misbehave: down, rate limit, latency, failures.
import type { NextFunction, Request, Response } from 'express';
import { sleep } from '@lab/node-common';
import { config, injected, stats } from './config.ts';

export class TokenBucket {
  tokens = -1;
  last = 0;

  // Takes `cost` tokens if available and returns 0, else returns seconds until they will be.
  // The rate is passed on every call so config changes apply immediately.
  take(ratePerSecond: number, burst = Math.max(1, ratePerSecond), cost = 1): number {
    const now = performance.now() / 1000;
    if (this.tokens < 0) this.tokens = burst;
    this.tokens = Math.min(burst, this.tokens + (now - this.last) * ratePerSecond);
    this.last = now;
    if (cost > burst) return Infinity;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return 0;
    }
    return (cost - this.tokens) / ratePerSecond;
  }
}

export function rejectRateLimited(res: Response, waitSeconds: number) {
  stats.injected.rateLimited++;
  injected.inc({ kind: '429' });
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(waitSeconds))));
  res.status(429).json({ error: 'rate_limited', retry_after_seconds: Number(waitSeconds.toFixed(3)) });
}

export function tenantOf(req: Request): string | undefined {
  return req.header('x-tenant-id') ?? (typeof req.query.tenant === 'string' ? req.query.tenant : undefined);
}

function pickLatency(tenant: string | undefined): number {
  const tail = config.p99LatencyMs > config.latencyMs && Math.random() < 0.01;
  const base = tail ? config.p99LatencyMs : config.latencyMs * (0.8 + Math.random() * 0.4);
  return base + (tenant ? (config.slowTenants[tenant] ?? 0) : 0);
}

const globalBucket = new TokenBucket();

export function chaos(options: { latency: boolean }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    stats.requests++;
    if (config.down === 'hang') {
      stats.injected.hung++;
      injected.inc({ kind: 'hang' });
      return; // never respond: the caller only finds out through its own timeout
    }
    if (config.down === '503') {
      stats.injected.unavailable++;
      injected.inc({ kind: '503' });
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }
    if (config.rateLimitRps > 0) {
      const wait = globalBucket.take(config.rateLimitRps);
      if (wait > 0) return rejectRateLimited(res, wait);
    }
    if (options.latency) await sleep(pickLatency(tenantOf(req)));
    if (Math.random() < config.failureRate) {
      stats.injected.failed++;
      injected.inc({ kind: '500' });
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    next();
  };
}
