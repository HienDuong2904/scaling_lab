// Sends signed order.created / order.updated webhooks to config.webhookTarget at
// config.webhooksPerMinute, with duplicates, out-of-order delivery and partner-style
// retries on timeouts or non-2xx responses. GET /admin/webhooks/orders returns the true
// final state of every order, so you can count how many your app got wrong.
//
// Verifying in your app:
//   signature = hex(HMAC-SHA256(secret, `${x-partner-timestamp}.${rawBody}`))
//   compare with x-partner-signature ("sha256=<hex>") using a constant-time compare.
import { createHmac } from 'node:crypto';
import client from 'prom-client';
import { logger, registry } from '@lab/node-common';
import { config } from './config.ts';

const secret = process.env.PARTNER_WEBHOOK_SECRET ?? 'whsec_lab';
const NEXT_STATUS: Record<string, string[]> = {
  pending: ['paid', 'paid', 'paid', 'cancelled'],
  paid: ['fulfilled', 'fulfilled', 'refunded'],
  fulfilled: ['delivered'],
};
const MAX_IN_FLIGHT = 2_000;
const MAX_TRACKED_ORDERS = 200_000;

type Order = { order_id: string; tenant_id: string; status: string; version: number; total: number; updated_at: string };
type Event = { id: string; topic: 'order.created' | 'order.updated'; tenant_id: string; created_at: string; data: Order };

const orders = new Map<string, Order>(); // the truth, in insertion order
let active: string[] = []; // orders that can still change status
let orderSeq = 0;
let eventSeq = 0;
let inFlight = 0;
let budget = 0;

const webhookResults = new client.Counter({
  name: 'partner_webhooks_total',
  help: 'Webhook delivery attempts by result',
  labelNames: ['result'],
  registers: [registry],
});

export const webhookStats = { generated: 0, attempts: 0, delivered: 0, failed: 0, timeouts: 0, retries: 0, duplicatesSent: 0, heldBack: 0, dropped: 0, gaveUp: 0 };

export function resetWebhooks() {
  orders.clear();
  active = [];
  budget = 0;
  for (const key of Object.keys(webhookStats) as (keyof typeof webhookStats)[]) webhookStats[key] = 0;
}

export function orderTruth() {
  return [...orders.values()];
}

function nextEvent(): Event {
  const now = new Date().toISOString();
  const cap = Math.max(1, config.webhookActiveOrders);
  const createNew = active.length < Math.min(50, cap) || (active.length < cap && Math.random() < 0.25);
  const index = Math.floor(Math.random() * active.length);
  const previous = createNew ? undefined : orders.get(active[index]);
  if (!createNew && !previous) active.splice(index, 1); // evicted from tracking; start a new one instead
  let order: Order;
  let topic: Event['topic'];
  if (!previous) {
    orderSeq++;
    order = {
      order_id: `ord_${orderSeq}`,
      tenant_id: `tenant_${1 + Math.floor(Math.random() * config.webhookTenants)}`,
      status: 'pending',
      version: 1,
      total: Math.round(Math.random() * 50_000) / 100,
      updated_at: now,
    };
    topic = 'order.created';
    active.push(order.order_id);
    if (orders.size >= MAX_TRACKED_ORDERS) orders.delete(orders.keys().next().value!);
  } else {
    const options = NEXT_STATUS[previous.status];
    order = { ...previous, status: options[Math.floor(Math.random() * options.length)], version: previous.version + 1, updated_at: now };
    topic = 'order.updated';
    if (!NEXT_STATUS[order.status]) active.splice(index, 1);
  }
  orders.set(order.order_id, order);
  eventSeq++;
  webhookStats.generated++;
  return { id: `evt_${eventSeq}`, topic, tenant_id: order.tenant_id, created_at: now, data: { ...order } };
}

async function deliver(event: Event, attempt: number) {
  const target = config.webhookTarget;
  if (!target) return;
  if (inFlight >= MAX_IN_FLIGHT) {
    webhookStats.dropped++;
    webhookResults.inc({ result: 'dropped' });
    return;
  }
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  inFlight++;
  webhookStats.attempts++;
  let result: 'delivered' | 'failed' | 'timeout';
  try {
    const res = await fetch(target, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(config.webhookTimeoutMs),
      headers: {
        'content-type': 'application/json',
        'x-partner-event-id': event.id,
        'x-partner-topic': event.topic,
        'x-partner-tenant': event.tenant_id,
        'x-partner-timestamp': timestamp,
        'x-partner-signature': `sha256=${signature}`,
        'x-partner-attempt': String(attempt + 1),
      },
    });
    await res.body?.cancel();
    result = res.ok ? 'delivered' : 'failed';
  } catch (err) {
    result = (err as Error).name === 'TimeoutError' ? 'timeout' : 'failed';
  } finally {
    inFlight--;
  }
  webhookResults.inc({ result });
  if (result === 'delivered') {
    webhookStats.delivered++;
    return;
  }
  if (result === 'timeout') webhookStats.timeouts++;
  else webhookStats.failed++;
  if (attempt < config.webhookMaxRetries) {
    webhookStats.retries++;
    setTimeout(() => void deliver(event, attempt + 1), 1000 * 2 ** attempt);
  } else {
    webhookStats.gaveUp++;
    logger.warn({ eventId: event.id, target }, 'webhook gave up after retries');
  }
}

function send(event: Event) {
  if (Math.random() < config.outOfOrderRate) {
    webhookStats.heldBack++;
    setTimeout(() => void deliver(event, 0), 2_000 + Math.random() * 3_000);
  } else {
    void deliver(event, 0);
  }
  if (Math.random() < config.duplicateRate) {
    webhookStats.duplicatesSent++;
    setTimeout(() => void deliver(event, 0), Math.random() * 3_000);
  }
}

setInterval(() => {
  if (!config.webhookTarget || config.webhooksPerMinute <= 0) return;
  budget += config.webhooksPerMinute / 600;
  for (; budget >= 1; budget--) send(nextEvent());
}, 100).unref();
