# Foodtale Review Migrator

Standalone migrator for backfilling missing `aspect_ratio` values on documents in the `reviews` collection.

Source collection: `reviews`. Target collection: `reviews` by default.

The migrator reads MongoDB and AWS settings from `.env`, scans review documents from `reviews`, computes `aspect_ratio` from the first non-video image in `media_paths` only when the source review is missing a positive value, and updates that review with a narrow `$set` for `aspect_ratio`.

It does not rewrite `media_paths`, convert images, generate WebP files, delete files, replace whole review documents, or modify unrelated review fields.

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

- `RESULT_COLLECTION_NAME=reviews`
- `MIGRATION_BATCH_SIZE=100`
- `MIGRATION_CONCURRENCY=5`

## Commands

Dry run without database writes:

```bash
npm run dry-run -- --limit=10
```

Update a small sample in `reviews`:

```bash
npm run migrate -- --limit=50 --concurrency=2
```

Backfill all eligible reviews:

```bash
npm run migrate
```

Optionally write a mirror collection for endpoint testing:

```bash
npm run migrate -- --result-collection=reviews_test --limit=50
```

## Flags

- `--limit=1000` limits how many source reviews are scanned.
- `--batch-size=100` controls Mongo cursor batch size and local processing chunks.
- `--concurrency=5` controls parallel S3 metadata reads and writes.
- `--result-collection=reviews` overrides `RESULT_COLLECTION_NAME`. The default is `reviews`.
- `--reset-result-collection` drops the result collection before copying. Ignored in dry-run mode and forbidden when targeting `reviews`.
- `--since=2025-01-01` only scans reviews created on or after the given date.
- `--review-id=<mongoId>` only scans one review.
- `--dry-run` logs intended updates without writing to MongoDB.

## Write Behavior

When targeting `reviews`, the migrator only writes documents that are missing a positive `aspect_ratio` and have readable image dimensions. It updates those documents with:

```js
{ $set: { aspect_ratio: computedValue } }
```

If you target another collection with `--result-collection`, each result document is a full copy of the source review document with the same `_id` and original fields. If the source review is missing a positive `aspect_ratio` and image dimensions can be read from S3, the copied document receives the computed `aspect_ratio`.

The migrator creates feed-friendly indexes only on non-`reviews` result collections, including `restaurant_id`, `created_at`, `approval`, `media_paths`, `media_ids`, and `location` as `2dsphere`.

## Reporting

The script prints summary counts when it finishes. Aspect-ratio lookup failures are written to:

```text
logs/review-aspect-ratio-migration-failures.jsonl
```

A failure does not block the rest of the migration. When targeting `reviews`, failed or image-less reviews are left unchanged.
