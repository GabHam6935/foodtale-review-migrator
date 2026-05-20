const { GetObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const sharp = require("sharp");

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".flv",
  ".wmv",
]);

function createS3ClientFromEnv(env = process.env) {
  return new S3Client({
    region: env.AWS_DEFAULT_REGION_S3,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID_S3,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY_S3,
    },
  });
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function getS3KeyFromPath(pathOrUrl) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return safeDecodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch (_) {
    const withoutQuery = raw.split("?")[0].split("#")[0];
    return safeDecodeURIComponent(withoutQuery.replace(/^\/+/, ""));
  }
}

function getPathExtension(pathOrUrl) {
  const key = getS3KeyFromPath(pathOrUrl).toLowerCase();
  const fileName = key.split("/").pop() || "";
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.substring(dotIndex) : "";
}

function isVideoPath(pathOrUrl) {
  return VIDEO_EXTENSIONS.has(getPathExtension(pathOrUrl));
}

function firstImagePath(mediaPaths) {
  if (!Array.isArray(mediaPaths)) return null;

  return (
    mediaPaths.find((path) => {
      if (typeof path !== "string" || path.trim() === "") return false;
      return !isVideoPath(path);
    }) || null
  );
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function invalidDimensionsError(message, details = {}) {
  const error = new Error(message);
  error.code = "INVALID_DIMENSIONS";
  Object.assign(error, details);
  return error;
}

async function getImageAspectRatio({ s3Client, bucket, pathOrUrl }) {
  const key = getS3KeyFromPath(pathOrUrl);
  if (!key) {
    throw invalidDimensionsError("Image path did not resolve to an S3 key");
  }

  let response;
  try {
    response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
  } catch (error) {
    error.s3Key = key;
    throw error;
  }

  const buffer = await streamToBuffer(response.Body);
  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;

  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    throw invalidDimensionsError("Image metadata did not include valid dimensions", {
      key,
      width,
      height,
    });
  }

  return {
    aspectRatio: Number((width / height).toFixed(6)),
    width,
    height,
    key,
    contentType: response.ContentType,
  };
}

module.exports = {
  createS3ClientFromEnv,
  firstImagePath,
  getImageAspectRatio,
  getS3KeyFromPath,
  isVideoPath,
};
