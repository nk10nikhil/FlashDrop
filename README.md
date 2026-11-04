# FlashDrop --- High-Concurrency Order Processing

FlashDrop is a flash-sale order-processing system designed around one
critical requirement: **many customers must be able to compete for
limited inventory without the system overselling the product**.

The reference workload is 10,000 customers attempting to purchase the
same product within seconds while only 100 units are available. The
design uses PostgreSQL as the authoritative inventory store, atomic
conditional updates for stock reservation, database-backed idempotency,
a transactional outbox, Kafka-compatible event streaming, and
independently scalable background workers.

------------------------------------------------------------------------

## Table of contents

-   [Problem statement](#problem-statement)
-   [Goals and guarantees](#goals-and-guarantees)
-   [Architecture](#architecture)
-   [Technology stack](#technology-stack)
-   [How order processing works](#how-order-processing-works)
-   [Concurrency and inventory
    correctness](#concurrency-and-inventory-correctness)
-   [Idempotency](#idempotency)
-   [Transactional outbox and Kafka](#transactional-outbox-and-kafka)
-   [Failure handling](#failure-handling)
-   [Data model](#data-model)
-   [API reference](#api-reference)
-   [Repository structure](#repository-structure)
-   [Getting started](#getting-started)
-   [Environment configuration](#environment-configuration)
-   [Running the application](#running-the-application)
-   [Testing](#testing)
-   [Load testing](#load-testing)
-   [Observability](#observability)
-   [Security](#security)
-   [Production deployment on AWS](#production-deployment-on-aws)
-   [CI/CD](#cicd)
-   [Design trade-offs](#design-trade-offs)
-   [Known scope and future
    improvements](#known-scope-and-future-improvements)
-   [Assessment acceptance criteria](#assessment-acceptance-criteria)
-   [Interview explanation](#interview-explanation)
-   [Contributing](#contributing)
-   [License](#license)

------------------------------------------------------------------------

## Problem statement

A flash sale creates a burst of concurrent purchase requests for a small
quantity of stock. A naive implementation can oversell inventory when
two or more API instances read the same stock value and then
independently decrement it.

FlashDrop addresses the following scenario:

  -----------------------------------------------------------------------
  Parameter                                                      Scenario
  ------------------------------ ----------------------------------------
  Concurrent purchase attempts                                     10,000

  Initial available inventory                                         100

  Product                                                     `iphone_16`

  Example purchase quantity                                             1

  Required inventory outcome                             Never below zero

  Required retry behavior                Same idempotency key returns the
                                                           original order
  -----------------------------------------------------------------------

The system must remain correct when requests are retried, API instances
run in parallel, events are redelivered, workers crash, and
non-authoritative infrastructure such as Redis becomes unavailable.

## Goals and guarantees

### Core goals

-   Validate incoming order requests.
-   Reserve stock atomically.
-   Never oversell inventory.
-   Prevent duplicate orders when clients retry.
-   Persist accepted orders before acknowledging them to clients.
-   Process orders asynchronously.
-   Handle duplicate message delivery safely.
-   Recover from publisher, worker, cache, and API failures.
-   Scale API and worker processes independently.
-   Provide repeatable local development and a production deployment
    path.

### Correctness guarantees

1.  **PostgreSQL is the inventory authority.** A cache or in-memory data
    structure cannot authorize an order.
2.  **Inventory reservation is atomic.** The database decrements stock
    only when enough stock remains.
3.  **Order acceptance is transactional.** The order, inventory change,
    idempotency result, and outbox event are committed together.
4.  **Idempotency is durable.** A retry with the same key and same
    request returns the original result.
5.  **Events are treated as at-least-once.** Duplicate delivery is
    expected and handled by idempotent consumers.
6.  **Acknowledgment follows durable processing.** A worker acknowledges
    a message only after its database transaction commits.

------------------------------------------------------------------------

## Architecture

### System architecture diagram

![FlashDrop high-concurrency
architecture](docs/images/FlashDrop_Architecture_Diagram.png)


### Logical architecture

``` mermaid
flowchart TB
    Client[Customers / Clients]
    Gateway[Application Load Balancer / API Gateway]
    API[Stateless API Instances]
    Redis[(Redis Cache)]
    DB[(PostgreSQL - Authoritative Inventory)]
    Outbox[Transactional Outbox]
    Publisher[Outbox Publisher]
    Kafka[(Kafka / Redpanda)]
    Worker[Background Worker Group]
    DLQ[(Dead-letter Topic)]
    Monitor[Metrics / Logs / Traces]

    Client --> Gateway
    Gateway --> API
    API <--> Redis
    API --> DB
    DB --> Outbox
    Outbox --> Publisher
    Publisher --> Kafka
    Kafka --> Worker
    Worker --> DB
    Worker --> DLQ
    API -. telemetry .-> Monitor
    Publisher -. telemetry .-> Monitor
    Worker -. telemetry .-> Monitor
```

### Order lifecycle

``` mermaid
flowchart TD
    A[POST /orders] --> B[Authenticate and validate]
    B --> C[Claim idempotency key]
    C --> D{Existing key?}
    D -->|Same request| E[Return original response]
    D -->|Different request| F[HTTP 409 Conflict]
    D -->|New key| G[Begin PostgreSQL transaction]
    G --> H[Atomic conditional stock decrement]
    H --> I{Stock available?}
    I -->|No| J[Rollback and reject]
    I -->|Yes| K[Insert PENDING order]
    K --> L[Insert outbox event]
    L --> M[Persist idempotency response]
    M --> N[Commit transaction]
    N --> O[Return HTTP 202]
    L --> P[Outbox publisher]
    P --> Q[Kafka event]
    Q --> R[Idempotent worker]
    R --> S[Update order status]
    S --> T[Commit DB transaction]
    T --> U[Commit Kafka offset]
```

### Component responsibilities

  -----------------------------------------------------------------------
  Component                           Responsibility
  ----------------------------------- -----------------------------------
  API Gateway / Load Balancer         TLS termination, request routing,
                                      authentication integration, rate
                                      limiting

  API service                         Request validation, idempotency
                                      handling, order acceptance

  PostgreSQL                          Durable orders, inventory,
                                      idempotency, outbox,
                                      processed-event records

  Redis                               Product cache and optional
                                      rate-limit support; not
                                      authoritative for stock

  Transactional outbox                Persists event publication intent
                                      with the order transaction

  Outbox publisher                    Claims and publishes unpublished
                                      outbox records

  Kafka / Redpanda                    Buffers and transports asynchronous
                                      order events

  Background worker                   Consumes events and performs
                                      idempotent processing

  Dead-letter topic                   Holds messages that exhaust retry
                                      policy or cannot be processed

  OpenTelemetry                       Distributed traces and
                                      instrumentation

  Prometheus / Grafana / CloudWatch   Metrics, dashboards, logs, and
                                      alerts

  Docker                              Reproducible application packaging

  ECS Fargate                         Runs API, publisher, and worker
                                      containers independently

  Terraform                           Defines cloud infrastructure as
                                      code
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## Technology stack

The following is the proposed stack. Keep this table synchronized with
the dependencies and infrastructure actually present in the repository.

  -----------------------------------------------------------------------
  Layer                   Technology              Purpose
  ----------------------- ----------------------- -----------------------
  Runtime                 Node.js LTS             JavaScript runtime

  Language                TypeScript              Static typing and
                                                  maintainability

  API framework           Fastify                 HTTP API

  Validation              Zod                     Request and event
                                                  validation

  Database                PostgreSQL              Transactional
                                                  persistence and
                                                  inventory authority

  Database access         Drizzle ORM /           Schema management and
                          parameterized SQL       safe queries

  Cache                   Redis                   Cache and optional rate
                                                  limiting

  Event streaming         Kafka-compatible broker Asynchronous event
                                                  transport

  Local broker            Redpanda                Kafka-compatible local
                                                  development

  Worker                  Node.js + TypeScript    Background event
                                                  processing

  Frontend (if included)  React + TypeScript +    Operational dashboard
                          Vite                    

  Styling (if included)   Tailwind CSS            Dashboard styling

  Testing                 Vitest                  Unit and integration
                                                  tests

  HTTP testing            Fastify inject /        API tests
                          Supertest               

  Load testing            k6                      Concurrent workload
                                                  simulation

  Containers              Docker / Docker Compose Local and production
                                                  packaging

  CI/CD                   GitHub Actions          Automated checks and
                                                  deployment

  Cloud                   AWS                     Production hosting

  Container hosting       ECS Fargate             API and worker runtime

  Database hosting        RDS PostgreSQL          Managed relational
                                                  database

  Cache hosting           ElastiCache             Managed Redis

  Broker hosting          Amazon MSK              Managed Kafka

  Infrastructure          Terraform               Reproducible
                                                  infrastructure

  Observability           OpenTelemetry,          Traces, metrics, and
                          Prometheus, Grafana,    logs
                          CloudWatch              
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## How order processing works

1.  A client sends `POST /orders` with a unique idempotency key.
2.  The API authenticates the caller and validates the payload.
3.  The API starts a PostgreSQL transaction.
4.  It claims or checks the idempotency key using a database uniqueness
    constraint.
5.  It reserves inventory with an atomic conditional SQL update.
6.  It creates the order in `PENDING` state.
7.  It inserts an `OrderCreated` event into the outbox table.
8.  It stores the original response against the idempotency key.
9.  PostgreSQL commits the transaction.
10. The API returns `202 Accepted`.
11. An outbox publisher claims the unpublished event and publishes it to
    Kafka.
12. A background worker consumes the event.
13. The worker records the event ID and updates the order in one
    database transaction.
14. The worker commits the Kafka offset only after the database commit
    succeeds.
15. The order can then be retrieved using `GET /orders/:orderId`.

The acceptance transaction does not wait for downstream asynchronous
processing. It does wait for the database to durably commit the accepted
order and its publication intent.

------------------------------------------------------------------------

## Concurrency and inventory correctness

### Unsafe approach

Do not read stock into application memory, check it, and then update it
in a separate statement:

``` text
Read stock
Check stock >= requested quantity
Update stock = stock - requested quantity
```

Two API instances can read the same value before either update commits.
This can cause overselling.

### Atomic conditional update

Use a single conditional update:

``` sql
UPDATE products
SET available_stock = available_stock - $1,
    updated_at = NOW()
WHERE id = $2
  AND available_stock >= $1
RETURNING id, available_stock;
```

Interpret the result:

-   One returned row: inventory reservation succeeded.
-   No returned row: the product is missing or stock is insufficient.
    Perform a suitable lookup if the API needs to distinguish these
    cases.

PostgreSQL coordinates concurrent updates to the same row. The condition
is checked as part of the update, so concurrent API instances cannot
decrement the stock below zero using this operation.

### Transaction boundary

The following operations must be in one database transaction:

-   Idempotency key claim or validation.
-   Atomic inventory decrement.
-   Order insertion.
-   Outbox event insertion.
-   Idempotency response persistence.

If any required operation fails, roll back the transaction. This ensures
that a failed order does not leave inventory reserved.

### Two instances competing for the last item

Both instances execute the conditional update against the same
PostgreSQL row. PostgreSQL coordinates the conflicting writes. Only one
transaction can reserve the final unit; the other cannot satisfy
`available_stock >= 1`.

This works across separate processes and machines because the database
is the shared coordination boundary. An in-memory mutex would not
provide this guarantee across multiple instances.

------------------------------------------------------------------------

## Idempotency

Idempotency protects against retries when a client cannot determine
whether its original request succeeded.

Recommended database constraint:

``` sql
UNIQUE (user_id, idempotency_key)
```

Persist:

-   Authenticated user ID.
-   Idempotency key.
-   Canonical request hash.
-   Associated order ID.
-   Original HTTP status.
-   Original response body.
-   Creation timestamp.

  -----------------------------------------------------------------------
  Situation                           Expected behavior
  ----------------------------------- -----------------------------------
  New key                             Process the request normally

  Same key and same payload           Return the original response and
                                      order

  Same key and different payload      Return `409 Conflict`

  Concurrent requests with same key   Create at most one order and one
                                      inventory reservation

  Retry after API restart             Return the durable original result
  -----------------------------------------------------------------------

Calculate the request hash from a canonical representation of the
relevant request fields. Do not depend on arbitrary JSON property
ordering.

The uniqueness constraint in PostgreSQL is the final enforcement
mechanism. Redis may cache a response but must not be required for
idempotency correctness.

------------------------------------------------------------------------

## Transactional outbox and Kafka

### Why an outbox is needed

A database commit and a Kafka publish are two separate operations.
Without an outbox, the API could commit an order and crash before
publishing its event. Publishing before the database commit is also
unsafe because a worker could receive an event for an order that never
committed.

### Outbox workflow

1.  Insert the order and outbox event in the same PostgreSQL
    transaction.
2.  A separate publisher claims unpublished outbox rows.
3.  Publish the event to Kafka.
4.  Wait for broker acknowledgment.
5.  Mark the outbox row as published.
6.  Retry transient failures with backoff.

Use `SELECT ... FOR UPDATE SKIP LOCKED` or a safe lease-based claiming
mechanism so multiple publisher instances do not concurrently claim the
same active work.

### Delivery semantics

The outbox publisher can crash after Kafka accepts an event but before
the publisher records it as published. In that case, the event may be
published again after recovery.

Therefore:

-   Assume at-least-once delivery.
-   Give every event a stable ID.
-   Make consumers idempotent.
-   Do not claim end-to-end exactly-once processing.

### Example event

``` json
{
  "eventId": "event-uuid",
  "eventType": "OrderCreated",
  "orderId": "order-uuid",
  "userId": "user_123",
  "productId": "iphone_16",
  "quantity": 1,
  "occurredAt": "2026-11-04T10:00:00Z"
}
```

------------------------------------------------------------------------

## Failure handling

  -----------------------------------------------------------------------
  Failure scenario                    Expected behavior
  ----------------------------------- -----------------------------------
  Kafka delivers an event twice       Worker deduplicates using a
                                      database uniqueness constraint

  Redis becomes unavailable after     Order and outbox remain durable in
  acceptance                          PostgreSQL; cache falls back

  Worker crashes after DB commit but  Kafka redelivers; worker detects
  before Kafka acknowledgment         the processed event and safely
                                      acknowledges

  API crashes after accepting an      Client retries with the same
  order but before responding         idempotency key and receives the
                                      original order

  Publisher crashes after Kafka       Event may be published again;
  acknowledgment but before marking   idempotent consumer prevents
  outbox published                    duplicate business effects

  Kafka is unavailable                Outbox records remain pending and
                                      are retried after recovery

  PostgreSQL is unavailable           API fails closed; it must not
                                      report an order as accepted

  Worker repeatedly fails an event    Bounded retry policy, then
                                      dead-letter topic

  API instance fails                  Load balancer routes traffic to
                                      healthy instances; committed data
                                      remains durable
  -----------------------------------------------------------------------

### Worker deduplication

The worker must insert the event ID into a `processed_events` table and
update the order within the same PostgreSQL transaction.

If the event ID already exists, the worker must not repeat the business
operation. Commit or acknowledge the duplicate safely.

### Dead-letter handling

Messages that exhaust the retry policy should be sent to a dead-letter
topic with useful diagnostic metadata. Provide a controlled replay
procedure; do not silently discard failed events.

------------------------------------------------------------------------

## Data model

The logical schema includes the following tables. Use migrations as the
source of truth for exact column types and constraints.

### `products`

  Column              Purpose
  ------------------- ---------------------------
  `id`                Product primary key
  `name`              Product name
  `sku`               Unique stock keeping unit
  `available_stock`   Available quantity
  `created_at`        Creation timestamp
  `updated_at`        Update timestamp

### `orders`

  Column              Purpose
  ------------------- ---------------------------------
  `id`                Order UUID
  `user_id`           Authenticated customer identity
  `product_id`        Product reference
  `quantity`          Requested quantity
  `status`            Order lifecycle status
  `idempotency_key`   Request retry key or reference
  `request_hash`      Canonical request fingerprint
  `created_at`        Creation timestamp
  `updated_at`        Update timestamp

### `idempotency_records`

  Column              Purpose
  ------------------- --------------------------
  `user_id`           Key owner
  `idempotency_key`   Client-supplied key
  `request_hash`      Detects payload mismatch
  `order_id`          Original order
  `response_status`   Original HTTP status
  `response_body`     Replayable response
  `created_at`        Record timestamp

Constraint: `UNIQUE(user_id, idempotency_key)`.

### `outbox_events`

  Column              Purpose
  ------------------- ------------------------------------------------
  `id`                Event UUID
  `aggregate_id`      Associated order ID
  `event_type`        Event name
  `payload`           Serialized event
  `created_at`        Creation timestamp
  `published_at`      Publication timestamp; nullable
  `attempts`          Publication attempts
  `next_attempt_at`   Retry schedule
  lease fields        Claim ownership and recovery metadata, if used

### `processed_events`

  Column            Purpose
  ----------------- ------------------------------------------
  `event_id`        Stable event identity
  `consumer_name`   Logical consumer identity, if applicable
  `processed_at`    Processing timestamp

Use a uniqueness constraint for the event identity and logical consumer
scope.

------------------------------------------------------------------------

## API reference

The following describes the intended API contract. Verify exact route
paths and response bodies against the running implementation.

### `POST /orders`

Creates an order and reserves inventory.

Request:

``` json
{
  "userId": "user_123",
  "productId": "iphone_16",
  "quantity": 1,
  "idempotencyKey": "request_abc123"
}
```

Accepted response:

``` http
HTTP/1.1 202 Accepted
```

``` json
{
  "orderId": "order-uuid",
  "status": "PENDING"
}
```

In production, derive the user identity from authentication. Do not
trust a caller-supplied `userId` without authorization.

Possible response codes:

  Status          Meaning
  --------------- --------------------------------------------------------------
  `202`           Order durably accepted and pending asynchronous processing
  `400`           Invalid request
  `401`           Unauthenticated
  `403`           Not authorized
  `404`           Product not found
  `409`           Idempotency key reused with a different payload
  `422`           Insufficient inventory, if this is the chosen API convention
  `429`           Rate limit exceeded
  `500` / `503`   Unexpected or temporary service failure

Choose and document one consistent insufficient-stock response
convention.

### `GET /orders/:orderId`

Returns order details and current status.

Example response:

``` json
{
  "orderId": "order-uuid",
  "userId": "user_123",
  "productId": "iphone_16",
  "quantity": 1,
  "status": "PENDING",
  "createdAt": "2026-11-04T10:00:00.000Z"
}
```

Apply authorization so a user cannot retrieve another user's order.

### `GET /products/:productId`

Returns product details and a point-in-time inventory view. A displayed
stock value is not a reservation guarantee.

### `GET /health`

Liveness check indicating that the process is running.

### `GET /ready`

Readiness check for dependencies required by the instance to accept
traffic.

### `GET /metrics`

Operational metrics endpoint. Restrict access to the monitoring network
or an authorized operator.

------------------------------------------------------------------------

## Repository structure

The following is a suggested monorepo structure. Adjust it to match the
actual repository.

``` text
flashdrop/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── routes/
│   │       ├── controllers/
│   │       ├── services/
│   │       ├── middleware/
│   │       ├── validators/
│   │       └── server.ts
│   ├── worker/
│   │   └── src/
│   │       ├── consumers/
│   │       ├── processors/
│   │       └── worker.ts
│   └── dashboard/                 # Optional frontend
├── packages/
│   ├── database/
│   │   ├── schema/
│   │   ├── migrations/
│   │   └── seeds/
│   ├── messaging/
│   ├── shared/
│   └── observability/
├── infrastructure/
│   ├── docker/
│   ├── terraform/
│   └── monitoring/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── concurrency/
│   ├── failure-scenarios/
│   └── e2e/
├── load-tests/
├── docs/
│   └── images/
│       └── FlashDrop_Architecture_Diagram.png
├── scripts/
├── .github/
│   └── workflows/
├── docker-compose.yml
├── .env.example
├── package.json
└── README.md
```

------------------------------------------------------------------------

## Getting started

### Prerequisites

For local development, install:

-   Node.js LTS.
-   pnpm (if the repository uses pnpm workspaces).
-   Docker Desktop or Docker Engine with the Compose plugin.
-   Git.

You do not need to install PostgreSQL, Redis, or Kafka separately if the
local Docker Compose environment provides them.

### Clone the repository

``` bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd flashdrop
```

### Install dependencies

``` bash
pnpm install
```

### Configure environment variables

``` bash
cp .env.example .env
```

Review `.env` and configure local values. Never commit `.env` or real
credentials.

### Start local services

``` bash
docker compose up --build -d
```

Inspect service status:

``` bash
docker compose ps
```

Follow API logs:

``` bash
docker compose logs -f api
```

Follow worker logs:

``` bash
docker compose logs -f worker
```

------------------------------------------------------------------------

## Environment configuration

An example `.env.example` may contain:

``` dotenv
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

DATABASE_URL=postgresql://flashdrop:flashdrop_local@localhost:5432/flashdrop

REDIS_URL=redis://localhost:6379

KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=flashdrop
KAFKA_CONSUMER_GROUP=flashdrop-workers
KAFKA_ORDER_TOPIC=orders
KAFKA_DLQ_TOPIC=orders-dlq

IDEMPOTENCY_TTL_SECONDS=86400
OUTBOX_POLL_INTERVAL_MS=1000

# Development-only authentication configuration.
# Use a real identity provider and secret manager in production.
AUTH_MODE=development
```

Use the exact variable names expected by the implementation. These
values are local placeholders, not production credentials.

------------------------------------------------------------------------

## Running the application

### Start

``` bash
docker compose up --build -d
```

### Stop

``` bash
docker compose down
```

### Stop and remove local volumes

``` bash
docker compose down -v
```

### Example API request

``` bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: request_abc123" \
  -d '{
    "userId": "user_123",
    "productId": "iphone_16",
    "quantity": 1,
    "idempotencyKey": "request_abc123"
  }'
```

Example order lookup:

``` bash
curl http://localhost:3000/orders/<ORDER_ID>
```

Example product lookup:

``` bash
curl http://localhost:3000/products/iphone_16
```

If authentication is enabled, include the required authorization header.
The exact local authentication procedure must be documented by the
implementation.

------------------------------------------------------------------------

## Testing

The test suite should verify correctness, not just successful HTTP
responses.

### Unit tests

Test:

-   Request validation.
-   Request hashing and canonicalization.
-   Order state transitions.
-   Event schema validation.
-   Retry and backoff logic.

### Integration tests

Test:

-   Database migrations.
-   Order creation.
-   Transaction rollback.
-   Idempotency persistence.
-   Outbox insertion and publication.
-   Worker processing.
-   Redis fallback.

### Concurrency tests

Test:

-   Multiple simultaneous purchases against one product.
-   Multiple API processes.
-   Two requests competing for the last unit.
-   Concurrent requests sharing the same idempotency key.
-   Same key with different request payloads.

### Failure tests

Test the four assessment scenarios:

1.  Kafka delivers an order event twice.
2.  Redis becomes unavailable after an order is accepted.
3.  A worker crashes after committing its database transaction but
    before acknowledging the event.
4.  The API crashes after committing an order but before responding to
    the client.

Also test broker outage, publisher crash after publication, database
outage, and dead-letter behavior.

### Suggested commands

``` bash
pnpm test
pnpm test:integration
pnpm test:concurrency
pnpm test:failure
```

Only list a command as supported after adding it to the repository
scripts and verifying it.

------------------------------------------------------------------------

## Load testing

Use k6 to simulate the flash-sale workload.

### Primary scenario

  Parameter                                                       Value
  ----------------------------------- ---------------------------------
  Virtual users / purchase attempts                              10,000
  Initial stock                                                     100
  Product                                                   `iphone_16`
  Quantity per request                                                1
  Idempotency key                       Unique per independent customer

### Expected result for a clean completed run

-   Exactly 100 successful inventory reservations.
-   9,900 insufficient-stock responses.
-   Final available inventory equals zero.
-   No negative inventory.
-   Exactly 100 distinct accepted orders.
-   No duplicate order creation.
-   All accepted orders are eventually processed when the worker and
    broker are healthy.

A test run with infrastructure errors or incomplete requests must be
reported separately rather than forced into the expected 100/9,900
split.

### Example k6 command

``` bash
k6 run load-tests/flash-sale.js
```

### Report actual measurements

Record:

-   Total completed requests.
-   Successful reservations.
-   Insufficient-stock responses.
-   Other errors.
-   Requests per second.
-   p50, p95, and p99 latency.
-   Final inventory.
-   Number of accepted orders.
-   Worker processing completion time.
-   Test machine and resource limits.

**Do not invent or estimate benchmark results.** Add measured numbers to
the README only after executing the test and recording the environment.

------------------------------------------------------------------------

## Observability

The production design should instrument the API, outbox publisher, and
workers.

### Metrics

-   HTTP request count and error rate.
-   API p50, p95, and p99 latency.
-   Order acceptance rate.
-   Successful inventory reservations.
-   Insufficient-stock rejections.
-   Idempotency replay count.
-   Database transaction failures.
-   Database connection pool usage.
-   Outbox backlog and oldest unpublished event age.
-   Kafka consumer lag.
-   Worker processing latency.
-   Retry count.
-   Dead-letter topic count.
-   Redis availability and cache hit rate.

### Logs and traces

Use structured logs and propagate a correlation ID through:

``` text
HTTP request
  -> API transaction
  -> order and outbox event
  -> Kafka message
  -> worker processing
  -> final order update
```

Avoid high-cardinality metric labels such as individual order IDs. Keep
those identifiers in logs and traces.

------------------------------------------------------------------------

## Security

-   Authenticate order creation and order retrieval.
-   Derive user identity from the authenticated principal.
-   Authorize access to each order.
-   Validate all incoming requests and consumed events.
-   Use parameterized SQL.
-   Apply rate limiting.
-   Restrict CORS to trusted origins.
-   Use secure HTTP headers.
-   Keep PostgreSQL, Redis, and Kafka off public networks.
-   Use TLS for external traffic and secure internal connections where
    supported.
-   Use least-privilege IAM roles.
-   Store production secrets in AWS Secrets Manager or an equivalent
    service.
-   Never commit credentials or production `.env` files.
-   Do not log tokens, passwords, or sensitive data.
-   Restrict administrative and metrics endpoints.

------------------------------------------------------------------------

## Production deployment on AWS

The proposed production deployment uses managed infrastructure to reduce
operational overhead.

### Service mapping

  Requirement                      AWS service
  -------------------------------- ---------------------------
  DNS                              Route 53
  HTTPS entry and load balancing   Application Load Balancer
  API and worker containers        ECS Fargate
  Container registry               ECR
  Relational database              RDS PostgreSQL
  Cache                            ElastiCache Redis
  Kafka-compatible event broker    Amazon MSK
  Secrets                          Secrets Manager
  Logs and alarms                  CloudWatch
  Infrastructure as code           Terraform
  CI/CD                            GitHub Actions with OIDC

### Deployment topology

``` mermaid
flowchart TB
    Internet[Internet] --> Route53[Route 53 / HTTPS]
    Route53 --> ALB[Application Load Balancer]
    ALB --> API[ECS Fargate API Service]
    API --> RDS[(RDS PostgreSQL)]
    API <--> Redis[(ElastiCache Redis)]
    RDS --> Publisher[Outbox Publisher]
    Publisher --> MSK[(Amazon MSK)]
    MSK --> Worker[ECS Fargate Worker]
    Worker --> RDS
    MSK --> DLQ[Dead-letter Topic]
    API --> CW[CloudWatch / OpenTelemetry]
    Worker --> CW
    CI[GitHub Actions] --> ECR[Amazon ECR]
    ECR --> API
    ECR --> Worker
```

### Networking

-   Use a VPC spanning multiple Availability Zones.
-   Place the load balancer in public subnets.
-   Place ECS tasks and data services in private subnets.
-   Do not expose PostgreSQL, Redis, or Kafka publicly.
-   Restrict security group ingress to required service paths.
-   Use encrypted storage and TLS.
-   Use IAM roles instead of hardcoded AWS credentials.

### Scaling

**API service**

-   Run multiple stateless tasks.
-   Scale using CPU, memory, request load, and latency.
-   Use health checks and rolling deployments.

**Worker service**

-   Scale independently from the API.
-   Use Kafka consumer lag and processing capacity as scaling signals.
-   Respect database connection and write capacity when increasing
    worker concurrency.

**Database**

-   Use managed PostgreSQL with Multi-AZ availability where appropriate.
-   Configure automated backups and point-in-time recovery.
-   Monitor connections, locks, I/O, transaction latency, and hot-row
    contention.
-   Use read replicas only for suitable read workloads, not as the
    authority for stock reservations.

### Deployment safety

Use backward-compatible database migrations and rolling application
deployments:

1.  Apply compatible schema changes.
2.  Deploy code that supports the current and new schema.
3.  Backfill data if needed.
4.  Switch application behavior.
5.  Remove obsolete schema in a later release.

Configure health checks and deployment rollback procedures. Test backup
restoration and failover; configuration alone is not proof of recovery.

### Terraform

Infrastructure should be defined in reusable Terraform modules and
environment-specific configuration.

Validate before provisioning:

``` bash
terraform fmt -check -recursive
terraform validate
terraform plan
```

Review the plan and expected cloud costs before applying. Do not
provision paid resources without explicit approval.

------------------------------------------------------------------------

## CI/CD

A proposed GitHub Actions pipeline:

### Pull requests

1.  Install dependencies.
2.  Run formatting and lint checks.
3.  Run TypeScript type checking.
4.  Run unit tests.
5.  Run integration tests.
6.  Build API, worker, and dashboard if present.
7.  Build Docker images.
8.  Validate Terraform.

### Main branch

1.  Repeat validation.
2.  Build immutable images tagged with the commit SHA.
3.  Authenticate to AWS using GitHub OIDC.
4.  Push images to ECR.
5.  Update ECS task definitions.
6.  Deploy API and worker services.
7.  Wait for health checks and service stability.
8.  Run smoke tests.
9.  Stop promotion or roll back if deployment is unhealthy.

Use protected GitHub environments for production deployments. Do not
store long-lived AWS access keys in repository secrets when OIDC is
available.

------------------------------------------------------------------------

## Design trade-offs

### PostgreSQL row contention

A flash sale for one product creates a hot inventory row. PostgreSQL
coordinates writes to preserve correctness, but contention can limit
throughput. Measure lock waits and transaction latency before
introducing more complex inventory allocation strategies.

### At-least-once messaging

Kafka consumers can receive duplicate events. The design handles
duplicates through durable event IDs and transactional consumer
processing rather than assuming exactly-once delivery.

### Outbox polling

Polling is straightforward and recoverable but introduces publication
delay and database overhead. Monitor outbox backlog and tune polling
based on measured workload.

### Redis cache staleness

Cached product information may be temporarily stale. The cache must
never be the authority for accepting an order.

### Managed infrastructure cost

RDS, ElastiCache, MSK, ECS, and multi-AZ networking have ongoing costs.
Local Docker Compose should remain sufficient for development and
assessment demonstration.

### Payment and fulfilment scope

The core assessment focuses on order acceptance and asynchronous
processing. Real payment authorization, refunds, fulfilment, shipping,
and compensation workflows require additional state machines and
integrations.

------------------------------------------------------------------------