const mongoose = require("mongoose");

const receiverProfileSchema = new mongoose.Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    organizationName: {
      type: String,
      required: true,
      trim: true
    },
    contactNumber: {
      type: String,
      required: true,
      trim: true
    },
    ratingTotal: {
      type: Number,
      default: 0,
      min: 0
    },
    ratingCount: {
      type: Number,
      default: 0,
      min: 0
    },
    averageRatingBasisPoints: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("ReceiverProfile", receiverProfileSchema);
