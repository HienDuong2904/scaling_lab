// The fake partner: pretends to be Shopify, a CRM or an LLM provider, and misbehaves on demand.
//
//   GET  /admin/config            current knobs
//   POST /admin/config            change knobs, e.g. {"latencyMs":100,"rateLimitRps":20}
//   POST /admin/reset             knobs back to defaults, counters and generated data cleared
//   GET  /admin/stats             request, fault, webhook and LLM counters
//   GET  /admin/webhooks/orders   true final state of every order sent by webhook
//
//   GET  /customers/:id, GET /customers?updated_since=&cursor=&limit=
//   POST /crm/contacts            generic "sync to CRM" call (echoes the body back)
//   POST /v1/embeddings, POST /v1/chat/completions
import express from 'express';
import { httpMetrics, logger, metricsHandler, requestContext } from '@lab/node-common';
import { chaos } from './chaos.ts';
import { config, resetConfig, resetStats, stats, updateConfig } from './config.ts';
import { customersRouter, resetCustomers } from './customers.ts';
import { llmRouter, llmStats, resetLlm } from './llm.ts';
import { orderTruth, resetWebhooks, webhookStats } from './webhooks.ts';

const app = express();
app.disable('x-powered-by');
app.use(requestContext(), httpMetrics());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
app.get('/metrics', metricsHandler);

app.get('/admin/config', (_req, res) => {
  res.json(config);
});
app.post('/admin/config', (req, res) => {
  const errors = updateConfig(req.body ?? {});
  if (errors.length) return void res.status(400).json({ errors });
  logger.info({ patch: req.body }, 'config changed');
  res.json(config);
});
app.post('/admin/reset', (_req, res) => {
  resetConfig();
  resetStats();
  resetCustomers();
  resetWebhooks();
  resetLlm();
  logger.info('reset to defaults');
  res.json(config);
});
app.get('/admin/stats', (_req, res) => {
  res.json({ ...stats, webhooks: webhookStats, llm: llmStats });
});
app.get('/admin/webhooks/orders', (_req, res) => {
  const orders = orderTruth();
  res.json({ count: orders.length, orders });
});

app.use('/v1', chaos({ latency: false })); // LLM routes have their own latency knobs
app.use(llmRouter);
app.use(chaos({ latency: true }));
app.use(customersRouter);
app.post('/crm/contacts', (req, res) => {
  res.status(201).json({ id: `crm_${Date.now().toString(36)}`, received: req.body });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => logger.info({ port }, 'fake partner listening'));
