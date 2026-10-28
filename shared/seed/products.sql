-- Products (Project 5 flash sale, Project 8 search).
--   make seed-products                (100k products)   make seed-products rows=1000000
-- Primary key only. Drops and recreates products.

\set ON_ERROR_STOP on
\if :{?rows} \else \set rows 100000 \endif
\if :{?tenants} \else \set tenants 200 \endif
\timing on

SELECT setseed(0.42);
DROP TABLE IF EXISTS products CASCADE;

CREATE TABLE products (
  id         bigint PRIMARY KEY,
  tenant_id  int NOT NULL,
  sku        text NOT NULL,
  name       text NOT NULL,
  category   text NOT NULL,
  price      numeric(12,2) NOT NULL,
  stock      int NOT NULL,
  updated_at timestamptz NOT NULL
);

INSERT INTO products
SELECT p,
       1 + (p % :tenants)::int,
       'SKU-' || lpad(p::text, 8, '0'),
       initcap((ARRAY['red','blue','green','black','white','silver','vintage','classic','pro','mini'])[1 + floor(random() * 10)::int]
         || ' ' || (ARRAY['cotton','leather','steel','bamboo','wool','glass','ceramic','carbon'])[1 + floor(random() * 8)::int]
         || ' ' || (ARRAY['shirt','bag','bottle','lamp','chair','watch','mug','jacket','phone case','backpack'])[1 + floor(random() * 10)::int]),
       (ARRAY['apparel','home','outdoor','electronics','kitchen','accessories'])[1 + floor(random() * 6)::int],
       round((1 + random() * 499)::numeric, 2),
       floor(random() * 500)::int,
       now() - random() * interval '1 year'
FROM generate_series(1, :rows) p;

-- Project 5 starts here: one product with exactly 100 left for the flash sale.
UPDATE products SET name = 'Flash Sale Sneakers', stock = 100 WHERE id = 1;

VACUUM (ANALYZE) products;
SELECT count(*) AS products, pg_size_pretty(pg_total_relation_size('products')) AS size FROM products;
