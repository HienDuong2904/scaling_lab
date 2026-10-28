// Shared plumbing for every Node service in the lab:
// - a JSON logger that stamps the current request ID on every line,
// - request-ID middleware (reads or creates x-request-id, echoes it back),
// - HTTP metrics with the names the shared Grafana dashboard queries.
//
// Usage:
//   const app = express();
//   app.use(requestContext(), httpMetrics());
//   app.get('/metrics', metricsHandler);

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import client from 'prom-client';

const service = process.env.SERVICE_NAME ?? 'unknown';

type Context = { requestId: string };
const als = new AsyncLocalStorage<Context>();

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin: () => {
    const requestId = als.getStore()?.requestId;
    return requestId ? { requestId } : {};
  },
});

export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

// Headers to pass on outbound calls so one request ID follows the whole chain.
export function propagationHeaders(): Record<string, string> {
  const requestId = getRequestId();
  return requestId ? { 'x-request-id': requestId } : {};
}

export function requestContext() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = req.header('x-request-id') || randomUUID();
    res.setHeader('x-request-id', requestId);
    als.run({ requestId }, next);
  };
}

export const registry = new client.Registry();
registry.setDefaultLabels({ service });
// Includes nodejs_eventloop_lag_p99_seconds, heap and GC metrics.
client.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 10 });

export const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests handled',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'HTTP requests currently being handled',
  registers: [registry],
});

// Projects with queues set this so the dashboard's "oldest message age" panel has data.
export const queueOldestMessageAge = new client.Gauge({
  name: 'lab_queue_oldest_message_age_seconds',
  help: 'Age of the oldest message waiting in a queue',
  labelNames: ['queue'],
  registers: [registry],
});

export function httpMetrics(options: { skip?: string[] } = {}) {
  const skip = new Set(options.skip ?? ['/metrics', '/health']);
  return (req: Request, res: Response, next: NextFunction) => {
    if (skip.has(req.path)) return next();
    const start = process.hrtime.bigint();
    httpInFlight.inc();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      httpInFlight.dec();
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // Label by route pattern (/customers/:id), never the raw URL, to keep cardinality bounded.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequests.inc(labels);
      httpDuration.observe(labels, seconds);
      const line = { method: req.method, url: req.originalUrl, status: res.statusCode, ms: Math.round(seconds * 1000) };
      if (res.statusCode >= 500) logger.warn(line, 'request failed');
      else logger.debug(line, 'request');
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  };
}

export async function metricsHandler(_req: Request, res: Response) {
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
