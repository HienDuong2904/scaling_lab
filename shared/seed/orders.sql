-- Orders dataset (Project 3 and everything built on it).
--   make seed-orders                 1M orders (about a minute)
--   make seed-orders rows=50000000   the full 50M (allow 15-30 minutes and ~15 GB of disk)
--
-- 200 tenants, tenant 1 owns 40% of customers and orders. created_at spread over 3 years.
-- Primary keys only, on purpose: adding the right indexes is Project 3's job.
-- amount is double precision on purpose too: Project 3 changes it to numeric(14,2), and
-- that type change rewrites the whole table. (numeric(10,2) -> numeric(14,2) would not.)
-- Drops and recreates tenants, customers, orders and order_items.

\set ON_ERROR_STOP on
\if :{?rows} \else \set rows 1000000 \endif
\if :{?tenants} \else \set tenants 200 \endif
\if :{?items} \else \set items 1 \endif
\timing on

SELECT set_config('seed.rows', :'rows', false),
       set_config('seed.tenants', :'tenants', false),
       set_config('seed.items', :'items', false);

DROP TABLE IF EXISTS order_items, orders, customers, tenants CASCADE;

CREATE TABLE tenants (
  id         int PRIMARY KEY,
  name       text NOT NULL,
  plan       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tenants (id, name, plan)
SELECT g, 'tenant_' || g, (ARRAY['free', 'pro', 'enterprise'])[1 + g % 3]
FROM generate_series(1, :tenants) g;

-- Tenant of a customer is a pure function of its ID, so orders can pick a customer
-- and know its tenant without a join: 40% go to tenant 1, the rest spread over 2..N.
CREATE FUNCTION pg_temp.tenant_of(c bigint, n int) RETURNS int
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN c % 10 < 4 THEN 1 ELSE 2 + ((c / 10) % (n - 1))::int END $$;

CREATE TABLE customers (
  id          bigint NOT NULL,
  tenant_id   int NOT NULL,
  external_id text NOT NULL,
  email       text NOT NULL,
  name        text NOT NULL,
  country     text NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE orders (
  id          bigint NOT NULL,
  tenant_id   int NOT NULL,
  customer_id bigint NOT NULL,
  external_id text NOT NULL,
  status      text NOT NULL,
  amount      double precision NOT NULL,
  currency    text NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE order_items (
  id         bigint NOT NULL,
  order_id   bigint NOT NULL,
  product_id bigint NOT NULL,
  quantity   int NOT NULL,
  unit_price double precision NOT NULL
);

-- Loaded in 1M-row chunks, each committed on its own, so progress shows and a huge
-- load never sits in one transaction. Primary keys are added after loading (faster).
DO $$
DECLARE
  total     bigint := current_setting('seed.rows')::bigint;
  n_tenants int    := current_setting('seed.tenants')::int;
  n_cust    bigint := greatest(1000, total / 10);
  chunk     bigint := 1000000;
  lo        bigint;
  span      interval := interval '3 years';
  t0        timestamptz := now() - interval '3 years';
BEGIN
  PERFORM setseed(0.42);

  lo := 1;
  WHILE lo <= n_cust LOOP
    INSERT INTO customers
    SELECT c, pg_temp.tenant_of(c, n_tenants), 'cus_' || c, 'customer' || c || '@example.com',
           'Customer ' || c, (ARRAY['VN','US','SG','JP','DE','FR','GB','AU'])[1 + (c % 8)],
           t0 + random() * span
    FROM generate_series(lo, least(lo + chunk - 1, n_cust)) c;
    COMMIT;
    lo := lo + chunk;
  END LOOP;
  RAISE NOTICE 'customers: %', n_cust;

  lo := 1;
  WHILE lo <= total LOOP
    INSERT INTO orders
    SELECT o, pg_temp.tenant_of(c, n_tenants), c, 'ord_' || o,
           CASE WHEN r < 0.05 THEN 'pending' WHEN r < 0.70 THEN 'paid' WHEN r < 0.88 THEN 'shipped'
                WHEN r < 0.95 THEN 'delivered' WHEN r < 0.98 THEN 'cancelled' ELSE 'refunded' END,
           round((5 + random() * random() * 995)::numeric, 2)::double precision,
           CASE WHEN c % 10 = 0 THEN 'USD' ELSE 'VND' END,
           created, created + random() * interval '10 days'
    FROM (
      SELECT o, 1 + floor(random() * n_cust)::bigint AS c, random() AS r,
             -- later dates are denser, like a growing business
             t0 + sqrt(random()) * span AS created
      FROM generate_series(lo, least(lo + chunk - 1, total)) o
    ) s;
    COMMIT;
    RAISE NOTICE 'orders: % / %', least(lo + chunk - 1, total), total;
    lo := lo + chunk;
  END LOOP;

  IF current_setting('seed.items')::int = 1 THEN
    lo := 1;
    WHILE lo <= total LOOP
      -- 1 to 3 items per order, 2 on average
      INSERT INTO order_items
      SELECT o * 4 + k, o, 1 + floor(random() * 100000)::bigint, 1 + floor(random() * 3)::int,
             round((1 + random() * 300)::numeric, 2)::double precision
      FROM generate_series(lo, least(lo + chunk - 1, total)) o,
           LATERAL generate_series(1, 1 + (o % 3)::int) k;
      COMMIT;
      lo := lo + chunk;
    END LOOP;
    RAISE NOTICE 'order_items: done';
  END IF;
END $$;

ALTER TABLE customers ADD PRIMARY KEY (id);
ALTER TABLE orders ADD PRIMARY KEY (id);
ALTER TABLE order_items ADD PRIMARY KEY (id);

-- New rows inserted by the projects continue after the seeded IDs.
CREATE SEQUENCE orders_id_seq OWNED BY orders.id;
SELECT setval('orders_id_seq', (SELECT max(id) FROM orders));
ALTER TABLE orders ALTER COLUMN id SET DEFAULT nextval('orders_id_seq');
CREATE SEQUENCE customers_id_seq OWNED BY customers.id;
SELECT setval('customers_id_seq', (SELECT max(id) FROM customers));
ALTER TABLE customers ALTER COLUMN id SET DEFAULT nextval('customers_id_seq');

VACUUM (ANALYZE) tenants, customers, orders, order_items;

SELECT 'orders' AS "table", count(*) AS rows, pg_size_pretty(pg_total_relation_size('orders')) AS size FROM orders
UNION ALL
SELECT 'order_items', count(*), pg_size_pretty(pg_total_relation_size('order_items')) FROM order_items
UNION ALL
SELECT 'customers', count(*), pg_size_pretty(pg_total_relation_size('customers')) FROM customers;

SELECT tenant_id, count(*) AS orders, round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM orders GROUP BY tenant_id ORDER BY orders DESC LIMIT 3;
