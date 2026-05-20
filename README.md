# Foodtale Review Migrator

Standalone migrator for creating a full `reviews_test` mirror of the `reviews` collection while backfilling missing `aspect_ratio` values on the copied documents.

Source collection: `reviews`. Result collection: `reviews_test` by default.

The migrator reads MongoDB and AWS settings from `.env`, scans full review documents from `reviews`, computes `aspect_ratio` from the first non-video image in `media_paths` only when the source review is missing a positive value, and upserts the full review-shaped document into the configured output collection using the same `_id`.

It does not update `reviews`, rewrite `media_paths`, convert images, generate WebP files, delete files, or modify unrelated source review fields.

## Setup

```bash
npm install
```

Create `.env` from `.env.example` and fill in the values:

```bash
cp .env.example .env
```

Required values:

- `MONGO_DB_CONNECTION_STRING`
- `MONGO_DB_USERNAME`
- `MONGO_DB_PASSWORD`
- `MONGO_DB_NAME`
- `AWS_BUCKET_S3`
- `AWS_DEFAULT_REGION_S3`
- `AWS_ACCESS_KEY_ID_S3`
- `AWS_SECRET_ACCESS_KEY_S3`

Optional defaults:

- `RESULT_COLLECTION_NAME=reviews_test`
- `MIGRATION_BATCH_SIZE=100`
- `MIGRATION_CONCURRENCY=5`

## Commands

Dry run without database writes:

```bash
npm run dry-run -- --limit=10
```

Copy a small sample into `reviews_test`:

```bash
npm run migrate -- --limit=50 --concurrency=2
```

Create a clean full mirror in `reviews_test` after sample batches are verified:

```bash
npm run migrate -- --reset-result-collection
```

Override the result collection from the command line:

```bash
npm run migrate -- --result-collection=reviews_test --limit=50
```

## Flags

- `--limit=1000` limits how many source reviews are scanned.
- `--batch-size=100` controls Mongo cursor batch size and local processing chunks.
- `--concurrency=5` controls parallel S3 metadata reads and result upserts.
- `--result-collection=reviews_test` overrides `RESULT_COLLECTION_NAME`.
- `--reset-result-collection` drops the result collection before copying. Ignored in dry-run mode.
- `--since=2025-01-01` only scans reviews created on or after the given date.
- `--review-id=<mongoId>` only scans one review.
- `--dry-run` logs intended copied documents without writing to MongoDB.

## Result Collection Shape

Each result document is a full copy of the source review document with the same `_id` and original fields. If the source review is missing a positive `aspect_ratio` and image dimensions can be read from S3, the copied document receives the computed `aspect_ratio`.

The migrator creates feed-friendly indexes on the result collection, including `restaurant_id`, `created_at`, `approval`, `media_paths`, `media_ids`, and `location` as `2dsphere`.

## Reporting

The script prints summary counts when it finishes. Aspect-ratio lookup failures are written to:

```text
logs/review-aspect-ratio-migration-failures.jsonl
```

A failure does not block copying the review. The review is still copied to the result collection with its original fields so `reviews_test` can remain a complete endpoint test collection.
