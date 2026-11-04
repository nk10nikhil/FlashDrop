CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  name text NOT NULL,
  sku text NOT NULL UNIQUE,
  available_stock integer NOT NULL CHECK (available_stock >= 0),
  reserved_stock integer NOT NULL DEFAULT 0 CHECK (reserved_stock >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  product_id text NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED')),
  total_amount integer,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_user_idem_unique UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS orders_product_created_idx ON orders(product_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_user_key_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT idempotency_order_unique UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id uuid NOT NULL REFERENCES orders(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  last_error text
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(next_attempt_at, created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS processed_events (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processed_events_at_idx ON processed_events(processed_at);
