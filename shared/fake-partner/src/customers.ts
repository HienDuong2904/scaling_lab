// A 1M-record customer dataset generated from the ID, so nothing is stored.
// Base records have updated_at spread over 2023-2025 in ID order. Records edited later
// (customerUpdatesPerMinute) move to the end of the (updated_at, id) order, like a real
// "updated since" API, so incremental syncs see them.
import { Router } from 'express';
import { config } from './config.ts';
import { TokenBucket, rejectRateLimited } from './chaos.ts';

const BASE_START = Date.parse('2023-01-01T00:00:00Z');
const BASE_END = Date.parse('2026-01-01T00:00:00Z');

const FIRST = ['Ana', 'Bao', 'Chen', 'Dara', 'Eli', 'Farah', 'Gus', 'Hien', 'Ines', 'Jun', 'Kai', 'Lena', 'Minh', 'Nora', 'Omar', 'Priya'];
const LAST = ['Nguyen', 'Smith', 'Tran', 'Garcia', 'Kim', 'Muller', 'Rossi', 'Sato', 'Le', 'Silva', 'Khan', 'Novak'];
const COUNTRIES = ['VN', 'US', 'SG', 'JP', 'DE', 'FR', 'GB', 'AU', 'TH', 'KR'];

export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseUpdatedAt(id: number): number {
  return BASE_START + Math.floor(((id - 1) * (BASE_END - BASE_START)) / config.customersTotal);
}

type Edit = { updatedAt: number; version: number };
const edits = new Map<number, Edit>();
const editLog: { id: number; updatedAt: number }[] = []; // strictly increasing updatedAt

export function editCustomer(id: number) {
  const last = editLog.at(-1)?.updatedAt ?? 0;
  const updatedAt = Math.max(Date.now(), last + 1);
  const version = (edits.get(id)?.version ?? 1) + 1;
  edits.set(id, { updatedAt, version });
  editLog.push({ id, updatedAt });
}

export function resetCustomers() {
  edits.clear();
  editLog.length = 0;
}

export function customer(id: number) {
  const rand = seeded(id);
  const first = FIRST[Math.floor(rand() * FIRST.length)];
  const last = LAST[Math.floor(rand() * LAST.length)];
  const edit = edits.get(id);
  const version = edit?.version ?? 1;
  return {
    id,
    external_id: `cus_${id.toString(36).padStart(6, '0')}`,
    email: `${first}.${last}.${id}@example.com`.toLowerCase(),
    name: `${first} ${last}`,
    country: COUNTRIES[Math.floor(rand() * COUNTRIES.length)],
    total_spent: Math.round(rand() * 500_000) / 100 + (version - 1) * 10,
    orders_count: Math.floor(rand() * 40) + (version - 1),
    version,
    created_at: new Date(BASE_START + Math.floor(rand() * (baseUpdatedAt(id) - BASE_START + 1))).toISOString(),
    updated_at: new Date(edit?.updatedAt ?? baseUpdatedAt(id)).toISOString(),
  };
}

// Cursor phases: "b" walks base records by ID, "e" walks the edit log by time.
type Cursor = { p: 'b'; id: number } | { p: 'e'; t: number };
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(raw: string): Cursor | undefined {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if ((c.p === 'b' && Number.isInteger(c.id)) || (c.p === 'e' && Number.isFinite(c.t))) return c;
  } catch {}
  return undefined;
}

function firstIndex(length: number, isAtOrAfter: (i: number) => boolean): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (isAtOrAfter(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function listPage(since: number, cursor: Cursor | undefined, limit: number) {
  const data: ReturnType<typeof customer>[] = [];
  let next: Cursor | undefined;

  if (!cursor || cursor.p === 'b') {
    const total = config.customersTotal;
    let id = cursor ? cursor.id + 1 : 1 + firstIndex(total, (i) => baseUpdatedAt(i + 1) >= since);
    for (; id <= total && data.length < limit; id++) {
      if (edits.has(id)) continue; // it now sorts by its edit time, in the second phase
      data.push(customer(id));
      next = { p: 'b', id };
    }
    if (data.length === limit) return { data, next };
  }

  const after = cursor?.p === 'e' ? cursor.t + 1 : since;
  for (let i = firstIndex(editLog.length, (j) => editLog[j].updatedAt >= after); i < editLog.length && data.length < limit; i++) {
    const entry = editLog[i];
    next = { p: 'e', t: entry.updatedAt };
    if (edits.get(entry.id)?.updatedAt !== entry.updatedAt) continue; // edited again later
    data.push(customer(entry.id));
  }
  return { data, next: data.length === limit ? next : undefined };
}

const listBucket = new TokenBucket();

export const customersRouter = Router();

// GET /customers?updated_since=2025-06-01T00:00:00Z&limit=250&cursor=...
// Sorted by (updated_at, id). Limited to customersListRps (default 2/s).
customersRouter.get('/customers', (req, res) => {
  const wait = listBucket.take(config.customersListRps);
  if (wait > 0) return rejectRateLimited(res, wait);

  const limit = Math.min(Number(req.query.limit ?? 50) || 50, config.customersMaxPageSize);
  const sinceRaw = typeof req.query.updated_since === 'string' ? req.query.updated_since : undefined;
  const since = sinceRaw ? Date.parse(sinceRaw) : -Infinity;
  if (Number.isNaN(since)) return void res.status(400).json({ error: 'updated_since must be an ISO date' });

  let cursor: Cursor | undefined;
  if (typeof req.query.cursor === 'string') {
    cursor = decode(req.query.cursor);
    if (!cursor) return void res.status(400).json({ error: 'invalid cursor' });
  }

  const page = listPage(since, cursor, limit);
  res.json({ data: page.data, next_cursor: page.next ? encode(page.next) : null, has_more: Boolean(page.next) });
});

customersRouter.get('/customers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1 || id > config.customersTotal) return void res.status(404).json({ error: 'not_found' });
  res.json(customer(id));
});

let editBudget = 0;
setInterval(() => {
  editBudget += config.customerUpdatesPerMinute / 600;
  const rand = Math.random;
  for (; editBudget >= 1; editBudget--) editCustomer(1 + Math.floor(rand() * config.customersTotal));
}, 100).unref();
