# FlashDrop --- Deployment Notes

## 1. Deployment Overview

Package the API and background worker as separate Docker images. Run the
API as a stateless service behind a load balancer and scale worker
processes independently according to queue depth and processing latency.

For a production deployment, the suggested AWS mapping is:

  -----------------------------------------------------------------------
  Concern                             Proposed service
  ----------------------------------- -----------------------------------
  Container image registry            Amazon Elastic Container Registry
                                      (ECR)

  API and worker compute              Amazon ECS on Fargate

  Traffic distribution and health     Application Load Balancer (ALB)
  checks                              

  Authoritative order and inventory   Amazon RDS for PostgreSQL
  data                                

  Cache / optional coordination       Amazon ElastiCache for Redis

  Asynchronous event transport        Amazon MSK for Kafka, or another
                                      managed message broker

  Secrets                             AWS Secrets Manager

  Logs and metrics                    Amazon CloudWatch
  -----------------------------------------------------------------------

The assessment version can be run locally without provisioning these
managed services.

## 2. Containerisation and Local Setup

-   Provide a Dockerfile for the API and, if it is a separate process,
    another image or command for the worker.
-   Pin dependency versions and use a small production runtime image.
-   Run the services locally with Docker Compose where applicable.
-   Keep configuration outside the image and supply it through
    environment variables.
-   Add health-check endpoints so the platform can distinguish a healthy
    instance from one that should receive no traffic.

The exact build and start commands should match the scripts in the
repository.

## 3. CI/CD Pipeline

Use GitHub Actions or an equivalent CI/CD system.

A typical pipeline should:

1.  Install dependencies and run formatting, linting, and static checks.
2.  Run unit and integration tests, including concurrent-order and
    idempotency tests.
3.  Build versioned API and worker container images.
4.  Scan dependencies and container images for known vulnerabilities.
5.  Push successful images to ECR.
6.  Deploy to a staging environment and run smoke tests.
7.  Promote the verified image to production using a rolling or
    blue/green deployment.

Deploy immutable image tags (preferably commit SHAs) rather than relying
on a mutable `latest` tag.

## 4. Scaling and Availability

-   Keep API instances stateless so multiple instances can run behind
    the ALB.
-   Scale API instances using CPU, memory, request rate, and latency.
-   Scale workers independently using queue depth, message age, and
    processing throughput.
-   Configure readiness and liveness/health checks.
-   Use rolling deployments with sufficient capacity to keep the service
    available during replacement.
-   Apply graceful shutdown: stop accepting new work, finish or safely
    release in-flight work, then terminate.
-   Configure sensible timeouts, retry limits, and connection pools.

For correctness across multiple API instances, inventory reservation and
idempotency must be enforced by shared durable storage using atomic
operations and uniqueness constraints. An in-process lock or in-memory
inventory is not sufficient across multiple instances.

## 5. Data, Persistence, and Backups

In production, PostgreSQL should be the source of truth for orders and
inventory.

-   Reserve stock with an atomic conditional database update or
    transaction so concurrent requests cannot oversell.
-   Enforce idempotency with a unique constraint on the appropriate
    idempotency scope/key.
-   Store order state transitions durably.
-   Use a transactional outbox (or an equivalent reliable publish
    mechanism) so an accepted order is not lost between committing the
    database transaction and publishing an event.
-   Enable automated database backups and point-in-time recovery where
    supported.
-   Define a retention policy and periodically test restoring backups
    into a separate environment.
-   Apply schema migrations as a controlled deployment step, using
    backward-compatible changes where possible.

Redis may be used for caching, rate limiting, or other justified
supporting functions. It should not be the sole authority for inventory
or accepted orders.

## 6. Security and Configuration

-   Terminate external traffic over HTTPS.
-   Keep credentials, signing keys, and broker/database passwords in a
    managed secret store such as AWS Secrets Manager.
-   Never commit secrets to source control or bake them into container
    images.
-   Use least-privilege IAM roles and separate permissions for API and
    worker services.
-   Validate request bodies and enforce authentication, authorization,
    and rate limits at the appropriate boundary.
-   Restrict database and broker network access to the services that
    need it.
-   Rotate secrets and keep dependencies and base images patched.
-   Avoid logging access tokens, passwords, payment data, or other
    sensitive values.

## 7. Monitoring and Logging

Collect structured logs with a request or correlation ID so an order can
be traced across the API, database, broker, and worker.

Monitor at least:

-   API request rate, latency, and error rate.
-   Order acceptance and rejection counts.
-   Inventory reservation conflicts and idempotency hits.
-   Database connection usage, query latency, and availability.
-   Broker availability, queue depth, consumer lag, and oldest-message
    age.
-   Worker throughput, processing latency, retries, and failures.
-   Dead-letter queue (DLQ) volume.

Configure alerts for sustained elevated errors, growing queue lag,
database saturation, and repeated worker failures. Keep health endpoints
lightweight and avoid exposing internal diagnostics publicly.

## 8. Failure Handling and Recovery

  -----------------------------------------------------------------------
  Failure scenario                    Expected handling
  ----------------------------------- -----------------------------------
  Duplicate broker delivery           Consumers must be idempotent.
                                      Persist a processed-event
                                      identifier or use a conditional
                                      order-state transition so the same
                                      event cannot complete the order
                                      twice.

  Redis unavailable after order       Continue using the durable database
  acceptance                          as the source of truth. Bypass or
                                      degrade cache-dependent
                                      functionality; do not lose an
                                      accepted order because a cache is
                                      down.

  Worker crashes after database write The broker may redeliver the
  but before broker acknowledgement   message. The worker must safely
                                      detect that the order/event was
                                      already processed before applying
                                      the effect again.

  API crashes after accepting an      The client retries with the same
  order but before returning the      idempotency key. The API returns
  response                            the previously recorded result
                                      instead of creating another order.

  Broker unavailable                  Persist the order and an outbox
                                      event in the same database
                                      transaction. Retry publishing from
                                      the outbox when the broker
                                      recovers; alert if the backlog
                                      grows.

  Database unavailable                Fail safely rather than
                                      acknowledging an order that cannot
                                      be durably recorded. Return an
                                      appropriate service error and allow
                                      a client retry with the same
                                      idempotency key.
  -----------------------------------------------------------------------

Use bounded retries with backoff and jitter. Route repeatedly failing
messages to a DLQ for inspection and controlled replay. Do not silently
discard failed order events.

## 9. Deployment and Rollback Procedure

1.  Run automated checks and tests against the release commit.
2.  Build and scan immutable container images.
3.  Deploy to staging and verify health checks and critical order flows.
4.  Apply backward-compatible database migrations.
5.  Roll out API and worker versions gradually.
6.  Verify error rates, latency, queue lag, and order processing after
    deployment.
7.  If health or business metrics regress, roll back to the previous
    known-good image.
8.  Keep database changes compatible with the rollback window; avoid
    destructive schema changes in the same release.
