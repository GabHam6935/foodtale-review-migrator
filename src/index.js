require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");
const Review = require("./reviewModel");
const {
  createS3ClientFromEnv,
  firstImagePath,
  getImageAspectRatio,
} = require("./imageMetadata");

const REQUIRED_ENV = [
  "MONGO_DB_CONNECTION_STRING",
  "MONGO_DB_USERNAME",
  "MONGO_DB_PASSWORD",
  "MONGO_DB_NAME",
  "AWS_BUCKET_S3",
  "AWS_DEFAULT_REGION_S3",
  "AWS_ACCESS_KEY_ID_S3",
  "AWS_SECRET_ACCESS_KEY_S3",
];

const SOURCE_COLLECTION_NAME = "reviews";
const DEFAULT_RESULT_COLLECTION_NAME = "reviews_test";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: null,
    batchSize: parsePositiveInt(process.env.MIGRATION_BATCH_SIZE, 100),
    concurrency: parsePositiveInt(process.env.MIGRATION_CONCURRENCY, 5),
    resultCollectionName:
      process.env.RESULT_COLLECTION_NAME || DEFAULT_RESULT_COLLECTION_NAME,
    resetResultCollection: false,
    since: null,
    reviewId: null,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--reset-result-collection") {
      args.resetResultCollection = true;
      continue;
    }

    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      throw new Error(`Unknown argument format: ${arg}`);
    }

    const [, key, value] = match;
    switch (key) {
      case "limit":
        args.limit = parsePositiveInt(value, null, "--limit");
        break;
      case "batch-size":
        args.batchSize = parsePositiveInt(value, null, "--batch-size");
        break;
      case "concurrency":
        args.concurrency = parsePositiveInt(value, null, "--concurrency");
        break;
      case "result-collection":
        args.resultCollectionName = value;
        break;
      case "reset-result-collection":
        args.resetResultCollection = value !== "false";
        break;
      case "since":
        args.since = parseDate(value, "--since");
        break;
      case "review-id":
        args.reviewId = value;
        break;
      case "dry-run":
        args.dryRun = value !== "false";
        break;
      default:
        throw new Error(`Unknown argument: --${key}`);
    }
  }

  args.resultCollectionName = validateCollectionName(args.resultCollectionName);
  if (args.resultCollectionName === SOURCE_COLLECTION_NAME && args.resetResultCollection) {
    throw new Error("--reset-result-collection cannot be used when updating the source reviews collection");
  }
  return args;
}

function parsePositiveInt(value, fallback, label = "value") {
  if (value === undefined || value === null || value === "") return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

function validateCollectionName(value) {
  const collectionName = String(value || "").trim();
  if (!collectionName) {
    throw new Error("Result collection name cannot be empty");
  }
  if (collectionName.includes("$") || collectionName.includes("\0")) {
    throw new Error("Result collection name cannot contain '$' or null bytes");
  }
  return collectionName;
}

function validateEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment values: ${missing.join(", ")}`);
  }
}

async function connectMongo() {
  await mongoose.connect(process.env.MONGO_DB_CONNECTION_STRING, {
    user: process.env.MONGO_DB_USERNAME,
    pass: process.env.MONGO_DB_PASSWORD,
    dbName: process.env.MONGO_DB_NAME,
  });
}

function buildReviewQuery(args) {
  const query = {};

  if (args.since) {
    query.created_at = { $gte: args.since };
  }

  if (args.reviewId) {
    query._id = args.reviewId;
  }

  return query;
}

function createStats() {
  return {
    scanned: 0,
    wouldCopy: 0,
    copied: 0,
    keptExistingAspectRatio: 0,
    computedAspectRatio: 0,
    copiedWithoutAspectRatio: 0,
    skippedInvalidDimensions: 0,
    failed: 0,
  };
}

function hasPositiveAspectRatio(review) {
  return Number.isFinite(review.aspect_ratio) && review.aspect_ratio > 0;
}

async function appendFailureLog(entry) {
  const logsDir = path.join(process.cwd(), "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const logPath = path.join(logsDir, "review-aspect-ratio-migration-failures.jsonl");
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function serializeError(error) {
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    s3_key: error.s3Key || error.key,
    stack: error.stack,
  };
}

async function buildReviewCopy(review, context) {
  const { s3Client, stats } = context;
  const copy = { ...review };

  if (hasPositiveAspectRatio(copy)) {
    stats.keptExistingAspectRatio += 1;
    return {
      document: copy,
      imagePath: null,
      metadata: null,
      status: "existing",
    };
  }

  const imagePath = firstImagePath(copy.media_paths);
  if (!imagePath) {
    stats.copiedWithoutAspectRatio += 1;
    return {
      document: copy,
      imagePath: null,
      metadata: null,
      status: "no-image",
    };
  }

  try {
    const metadata = await getImageAspectRatio({
      s3Client,
      bucket: process.env.AWS_BUCKET_S3,
      pathOrUrl: imagePath,
    });

    copy.aspect_ratio = metadata.aspectRatio;
    stats.computedAspectRatio += 1;

    return {
      document: copy,
      imagePath,
      metadata,
      status: "computed",
    };
  } catch (error) {
    if (error.code === "INVALID_DIMENSIONS") {
      stats.skippedInvalidDimensions += 1;
    } else {
      stats.failed += 1;
    }
    stats.copiedWithoutAspectRatio += 1;

    await appendFailureLog({
      review_id: String(copy._id),
      result_collection: context.args.resultCollectionName,
      media_path: imagePath,
      error: serializeError(error),
      created_at: new Date().toISOString(),
    });

    console.error(`[aspect-ratio-failed] review=${copy._id} media_path=${imagePath} error=${error.message}`);
    return {
      document: copy,
      imagePath,
      metadata: null,
      status: "failed",
    };
  }
}

async function dropObsoleteResultIndexes(collection) {
  const indexes = await collection.indexes().catch(() => []);
  for (const index of indexes) {
    if (index.name === "_id_") continue;

    const keys = Object.keys(index.key || {});
    if (keys.length === 1 && keys[0] === "review_id") {
      await collection.dropIndex(index.name);
      console.log(`[index] dropped obsolete result-row index=${index.name}`);
    }
  }
}

async function createIndexSafely(collection, keys) {
  try {
    await collection.createIndex(keys);
  } catch (error) {
    console.error(`[index-warning] keys=${JSON.stringify(keys)} error=${error.message}`);
  }
}

async function ensureResultCollectionIndexes(collection) {
  await dropObsoleteResultIndexes(collection);
  await createIndexSafely(collection, { restaurant_id: 1 });
  await createIndexSafely(collection, { created_at: -1 });
  await createIndexSafely(collection, { "approval.has_approved": 1, "approval.approved_by": 1 });
  await createIndexSafely(collection, { restaurant_id: 1, created_at: -1 });
  await createIndexSafely(collection, { media_paths: 1 });
  await createIndexSafely(collection, { media_ids: 1 });
  await createIndexSafely(collection, { location: "2dsphere" });
}

async function resetResultCollectionIfRequested(collection, args) {
  if (!args.resetResultCollection || args.dryRun) return;

  const collections = await mongoose.connection.db
    .listCollections({ name: args.resultCollectionName })
    .toArray();

  if (collections.length === 0) return;

  await collection.drop();
  console.log(`[reset] dropped result collection=${args.resultCollectionName}`);
}

async function processReview(review, context) {
  const { args, resultCollection, stats } = context;
  stats.scanned += 1;

  const prepared = await buildReviewCopy(review, context);

  if (args.dryRun) {
    stats.wouldCopy += 1;
    const aspectRatio = prepared.document.aspect_ratio ?? "missing";
    console.log(
      `[dry-run] collection=${args.resultCollectionName} review=${review._id} status=${prepared.status} aspect_ratio=${aspectRatio}`,
    );
    return;
  }

  try {
    await resultCollection.replaceOne(
      { _id: prepared.document._id },
      prepared.document,
      { upsert: true },
    );

    stats.copied += 1;
    const aspectRatio = prepared.document.aspect_ratio ?? "missing";
    console.log(
      `[copied] collection=${args.resultCollectionName} review=${review._id} status=${prepared.status} aspect_ratio=${aspectRatio}`,
    );
  } catch (error) {
    stats.failed += 1;
    await appendFailureLog({
      review_id: String(review._id),
      result_collection: args.resultCollectionName,
      stage: "copy",
      error: serializeError(error),
      created_at: new Date().toISOString(),
    });
    console.error(`[copy-failed] review=${review._id} error=${error.message}`);
  }
}

async function processWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex]);
      }
    }),
  );
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  validateEnv();

  console.log(
    `Starting review mirror migrator mode=${args.dryRun ? "dry-run" : "copy"} sourceCollection=${SOURCE_COLLECTION_NAME} resultCollection=${args.resultCollectionName} limit=${args.limit ?? "none"} batchSize=${args.batchSize} concurrency=${args.concurrency} reset=${args.resetResultCollection}`,
  );

  await connectMongo();

  const stats = createStats();
  const resultCollection = mongoose.connection.collection(args.resultCollectionName);
  await resetResultCollectionIfRequested(resultCollection, args);
  if (!args.dryRun) {
    await ensureResultCollectionIndexes(resultCollection);
  }

  const s3Client = createS3ClientFromEnv();
  const query = buildReviewQuery(args);
  const cursor = Review.find(query)
    .lean()
    .batchSize(args.batchSize)
    .cursor();

  let batch = [];
  let remaining = args.limit;

  for await (const review of cursor) {
    if (remaining !== null && remaining <= 0) break;

    batch.push(review);
    if (remaining !== null) remaining -= 1;

    if (batch.length >= args.batchSize) {
      await processWithConcurrency(batch, args.concurrency, (item) =>
        processReview(item, { args, resultCollection, s3Client, stats }),
      );
      batch = [];
    }
  }

  if (batch.length > 0) {
    await processWithConcurrency(batch, args.concurrency, (item) =>
      processReview(item, { args, resultCollection, s3Client, stats }),
    );
  }

  console.log("Migration summary:");
  console.table(stats);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
