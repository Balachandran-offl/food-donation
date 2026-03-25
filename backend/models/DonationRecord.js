const mongoose = require("mongoose");

const claimRequestSchema = new mongoose.Schema(
  {
    receiverAddress: {
      type: String,
      required: true,
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
    receiverRatingBasisPoints: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    donorRating: {
      type: Number,
      default: null,
      min: 1,
      max: 5
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      required: true
    },
    completed: {
      type: Boolean,
      default: false
    },
    requestHash: {
      type: String,
      required: true
    },
    requestedAt: {
      type: Date,
      default: null
    },
    reviewedAt: {
      type: Date,
      default: null
    },
    completedAt: {
      type: Date,
      default: null
    }
  },
  {
    _id: false
  }
);

const donationRecordSchema = new mongoose.Schema(
  {
    donorAddress: {
      type: String,
      required: true,
      index: true
    },
    foodType: {
      type: String,
      required: true,
      trim: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    location: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    contactNumber: {
      type: String,
      required: true,
      trim: true
    },
    expiryAt: {
      type: Date,
      default: null,
      index: true
    },
    imageFilename: {
      type: String,
      required: true
    },
    imageMimeType: {
      type: String,
      required: true
    },
    imageHash: {
      type: String,
      required: true
    },
    blockchainDonationId: {
      type: Number,
      default: null,
      unique: true,
      sparse: true
    },
    currentRequest: {
      type: claimRequestSchema,
      default: null
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("DonationRecord", donationRecordSchema);
