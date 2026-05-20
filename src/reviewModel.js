const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    media_paths: [String],
    aspect_ratio: Number,
    created_at: Date,
  },
  {
    collection: "reviews",
    strict: false,
    versionKey: false,
  },
);

module.exports = mongoose.models.Review || mongoose.model("Review", reviewSchema);
