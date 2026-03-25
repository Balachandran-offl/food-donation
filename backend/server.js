require("dotenv").config();

const cors = require("cors");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");
const multer = require("multer");
const { ethers } = require("ethers");

const DonationRecord = require("./models/DonationRecord");
const ReceiverProfile = require("./models/ReceiverProfile");

const REQUEST_STATUS = Object.freeze({
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected"
});
const ZERO_HASH = `0x${"0".repeat(64)}`;

const REQUEST_STATUS_CODE = Object.freeze({
  [REQUEST_STATUS.PENDING]: 1,
  [REQUEST_STATUS.ACCEPTED]: 2,
  [REQUEST_STATUS.REJECTED]: 3
});

const app = express();
const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const uploadsDir = path.join(__dirname, "uploads");
const port = Number(process.env.PORT || 4000);
const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  throw new Error("MONGODB_URI is required. Add it to backend/.env before starting the server.");
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      callback(new Error("Only image uploads are allowed."));
      return;
    }

    callback(null, true);
  }
});

function sanitizeText(value) {
  return String(value ?? "").trim();
}

function getExpiryTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsedDate = value instanceof Date ? value : new Date(value);
  const timestamp = parsedDate.getTime();

  return Number.isFinite(timestamp) ? timestamp : null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseExpiryAt(value, { requireFuture = false } = {}) {
  const rawValue = sanitizeText(value);

  if (!rawValue) {
    const error = new Error("Expiry date and time are required.");
    error.statusCode = 400;
    throw error;
  }

  const expiryAt = new Date(rawValue);
  const expiryTimestamp = getExpiryTimestamp(expiryAt);

  if (expiryTimestamp === null) {
    const error = new Error("Expiry date and time are invalid.");
    error.statusCode = 400;
    throw error;
  }

  if (requireFuture && expiryTimestamp <= Date.now()) {
    const error = new Error("Expiry date and time must be in the future.");
    error.statusCode = 400;
    throw error;
  }

  return expiryAt;
}

function parseRequiredHash(value, fieldName) {
  const hash = sanitizeText(value);

  if (!/^0x([A-Fa-f0-9]{64})$/.test(hash)) {
    const error = new Error(`${fieldName} must be a valid 0x-prefixed hash.`);
    error.statusCode = 400;
    throw error;
  }

  return hash;
}

function parseRating(value) {
  const rating = Number.parseInt(value, 10);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    const error = new Error("Rating must be a whole number between 1 and 5.");
    error.statusCode = 400;
    throw error;
  }

  return rating;
}

function parseReceiverRatingBasisPoints(value) {
  const ratingBasisPoints = Number.parseInt(value, 10);

  if (!Number.isInteger(ratingBasisPoints) || ratingBasisPoints < 0) {
    const error = new Error("Receiver rating snapshot is invalid.");
    error.statusCode = 400;
    throw error;
  }

  return ratingBasisPoints;
}

function ensureObjectId(value) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    const error = new Error("Invalid MongoDB record id.");
    error.statusCode = 400;
    throw error;
  }
}

function ensureLinkedDonation(record) {
  if (!record) {
    const error = new Error("Donation record not found in MongoDB.");
    error.statusCode = 404;
    throw error;
  }

  if (!Number.isInteger(record.blockchainDonationId) || record.blockchainDonationId <= 0) {
    const error = new Error("This donation is not linked to a blockchain record yet.");
    error.statusCode = 409;
    throw error;
  }
}

function isDonationExpired(record) {
  const expiryTimestamp = getExpiryTimestamp(record?.expiryAt);

  if (expiryTimestamp === null) {
    return false;
  }

  return expiryTimestamp <= Date.now();
}

function assertDonationNotExpired(record) {
  if (!isDonationExpired(record)) {
    return;
  }

  const error = new Error("This food donation has expired.");
  error.statusCode = 409;
  throw error;
}

function buildImageUrl(req, filename) {
  return `${req.protocol}://${req.get("host")}/uploads/${filename}`;
}

function computeDonationHash({
  donorAddress,
  foodType,
  quantity,
  location,
  contactNumber,
  expiryAt,
  imageHash
}) {
  const expiryTimestamp = getExpiryTimestamp(expiryAt);

  if (expiryTimestamp !== null) {
    return ethers.keccak256(
      abiCoder.encode(
        ["address", "string", "uint256", "string", "string", "uint256", "bytes32"],
        [
          donorAddress,
          foodType,
          BigInt(quantity),
          location,
          contactNumber,
          BigInt(expiryTimestamp),
          imageHash
        ]
      )
    );
  }

  return ethers.keccak256(
    abiCoder.encode(
      ["address", "string", "uint256", "string", "string", "bytes32"],
      [donorAddress, foodType, BigInt(quantity), location, contactNumber, imageHash]
    )
  );
}

function computeLegacyDonationHash({
  donorAddress,
  foodType,
  quantity,
  location,
  contactNumber,
  imageHash
}) {
  return ethers.keccak256(
    abiCoder.encode(
      ["address", "string", "uint256", "string", "string", "bytes32"],
      [donorAddress, foodType, BigInt(quantity), location, contactNumber, imageHash]
    )
  );
}

function computeStoredDonationHash(record) {
  return computeDonationHash({
    donorAddress: record.donorAddress,
    foodType: record.foodType,
    quantity: record.quantity,
    location: record.location,
    contactNumber: record.contactNumber,
    expiryAt: record.expiryAt,
    imageHash: record.imageHash
  });
}

function computeClaimRequestHash({
  donationId,
  donorAddress,
  receiverAddress,
  organizationName,
  contactNumber,
  receiverRatingBasisPoints,
  status,
  completed,
  donorRating
}) {
  const statusCode = REQUEST_STATUS_CODE[status];

  if (!statusCode) {
    throw new Error("Unsupported claim request status.");
  }

  return ethers.keccak256(
    abiCoder.encode(
      ["uint256", "address", "address", "string", "string", "uint256", "uint8", "bool", "uint256"],
      [
        BigInt(donationId),
        donorAddress,
        receiverAddress,
        organizationName,
        contactNumber,
        BigInt(receiverRatingBasisPoints),
        statusCode,
        completed,
        BigInt(donorRating || 0)
      ]
    )
  );
}

function serializeClaimRequest(request) {
  if (!request?.receiverAddress) {
    return null;
  }

  return {
    receiverAddress: request.receiverAddress,
    organizationName: request.organizationName,
    contactNumber: request.contactNumber,
    receiverRatingBasisPoints: request.receiverRatingBasisPoints,
    donorRating: request.donorRating,
    status: request.status,
    completed: Boolean(request.completed),
    requestHash: request.requestHash,
    requestedAt: request.requestedAt,
    reviewedAt: request.reviewedAt,
    completedAt: request.completedAt
  };
}

function serializeDonation(record, req) {
  return {
    recordId: record._id.toString(),
    donorAddress: record.donorAddress,
    foodType: record.foodType,
    quantity: record.quantity,
    location: record.location,
    contactNumber: record.contactNumber,
    expiryAt: record.expiryAt,
    isExpired: isDonationExpired(record),
    imageUrl: buildImageUrl(req, record.imageFilename),
    imageMimeType: record.imageMimeType,
    dataHash: computeStoredDonationHash(record),
    blockchainDonationId: record.blockchainDonationId,
    currentRequest: serializeClaimRequest(record.currentRequest),
    createdAt: record.createdAt
  };
}

async function verifyDonationRecordAgainstHashes(record, { onChainDataHash, onChainRequestHash }) {
  const imageBytes = await fs.readFile(path.join(uploadsDir, record.imageFilename));
  const imageHash = ethers.keccak256(imageBytes);
  const currentDonationHash = computeDonationHash({
    donorAddress: record.donorAddress,
    foodType: record.foodType,
    quantity: record.quantity,
    location: record.location,
    contactNumber: record.contactNumber,
    expiryAt: record.expiryAt,
    imageHash
  });
  const legacyDonationHash = computeLegacyDonationHash({
    donorAddress: record.donorAddress,
    foodType: record.foodType,
    quantity: record.quantity,
    location: record.location,
    contactNumber: record.contactNumber,
    imageHash
  });
  const normalizedOnChainDataHash = onChainDataHash.toLowerCase();
  const matchedDonationHash =
    currentDonationHash.toLowerCase() === normalizedOnChainDataHash
      ? currentDonationHash
      : legacyDonationHash.toLowerCase() === normalizedOnChainDataHash
        ? legacyDonationHash
        : null;

  let requestVerified;

  if (onChainRequestHash && onChainRequestHash.toLowerCase() !== ZERO_HASH.toLowerCase()) {
    if (!record.currentRequest) {
      requestVerified = false;
    } else {
      const expectedRequestHash = computeClaimRequestHash({
        donationId: record.blockchainDonationId,
        donorAddress: record.donorAddress,
        receiverAddress: record.currentRequest.receiverAddress,
        organizationName: record.currentRequest.organizationName,
        contactNumber: record.currentRequest.contactNumber,
        receiverRatingBasisPoints: record.currentRequest.receiverRatingBasisPoints,
        status: record.currentRequest.status,
        completed: Boolean(record.currentRequest.completed),
        donorRating: record.currentRequest.donorRating || 0
      });

      requestVerified = expectedRequestHash.toLowerCase() === onChainRequestHash.toLowerCase();
    }
  }

  return {
    donationVerified: Boolean(matchedDonationHash),
    requestVerified,
    matchedDonationHash,
    imageHash
  };
}

async function deleteStoredImage(filename) {
  if (!filename) {
    return;
  }

  await fs.unlink(path.join(uploadsDir, filename)).catch(() => {});
}

async function saveUploadFile(file) {
  const extension = path.extname(file.originalname) || ".bin";
  const filename = `${Date.now()}-${crypto.randomUUID()}${extension.toLowerCase()}`;
  const targetPath = path.join(uploadsDir, filename);

  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(targetPath, file.buffer);

  return { filename, targetPath };
}

async function loadDonationRecord(recordId) {
  ensureObjectId(recordId);
  return DonationRecord.findById(recordId);
}

async function upsertReceiverProfile({ receiverAddress, organizationName, contactNumber }) {
  const existingProfile = await ReceiverProfile.findOne({ walletAddress: receiverAddress });

  if (!existingProfile) {
    return ReceiverProfile.create({
      walletAddress: receiverAddress,
      organizationName,
      contactNumber
    });
  }

  existingProfile.organizationName = organizationName;
  existingProfile.contactNumber = contactNumber;
  await existingProfile.save();

  return existingProfile;
}

async function applyReceiverRating({ receiverAddress, organizationName, contactNumber, donorRating }) {
  let profile = await ReceiverProfile.findOne({ walletAddress: receiverAddress });

  if (!profile) {
    profile = new ReceiverProfile({
      walletAddress: receiverAddress,
      organizationName,
      contactNumber
    });
  }

  profile.organizationName = organizationName;
  profile.contactNumber = contactNumber;
  profile.ratingTotal += donorRating;
  profile.ratingCount += 1;
  profile.averageRatingBasisPoints = Math.round((profile.ratingTotal / profile.ratingCount) * 100);
  await profile.save();

  return profile;
}

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "FoodVerse backend is running." });
});

app.get("/api/donations", async (req, res, next) => {
  try {
    const location = sanitizeText(req.query.location);
    const query = {};

    if (location) {
      query.location = { $regex: escapeRegex(location), $options: "i" };
    }

    const records = await DonationRecord.find(query).sort({ blockchainDonationId: -1, createdAt: -1 });

    res.json({
      ok: true,
      donations: records.map((record) => serializeDonation(record, req))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/donations/prepare", upload.single("image"), async (req, res, next) => {
  let savedFile = null;

  try {
    const donorAddress = sanitizeText(req.body.donorAddress);
    const foodType = sanitizeText(req.body.foodType);
    const quantity = Number.parseInt(req.body.quantity, 10);
    const location = sanitizeText(req.body.location);
    const contactNumber = sanitizeText(req.body.contactNumber);
    const expiryAt = parseExpiryAt(req.body.expiryAt, { requireFuture: true });

    if (!ethers.isAddress(donorAddress)) {
      res.status(400).json({ ok: false, message: "A valid donor wallet address is required." });
      return;
    }

    if (!foodType || !location || !contactNumber) {
      res.status(400).json({ ok: false, message: "Food type, location, and contact number are required." });
      return;
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      res.status(400).json({ ok: false, message: "Quantity must be a positive whole number." });
      return;
    }

    if (!req.file) {
      res.status(400).json({ ok: false, message: "An image is required for each donation." });
      return;
    }

    const normalizedDonorAddress = ethers.getAddress(donorAddress);
    const imageHash = ethers.keccak256(req.file.buffer);
    const dataHash = computeDonationHash({
      donorAddress: normalizedDonorAddress,
      foodType,
      quantity,
      location,
      contactNumber,
      expiryAt,
      imageHash
    });

    savedFile = await saveUploadFile(req.file);

    const record = await DonationRecord.create({
      donorAddress: normalizedDonorAddress,
      foodType,
      quantity,
      location,
      contactNumber,
      expiryAt,
      imageFilename: savedFile.filename,
      imageMimeType: req.file.mimetype,
      imageHash
    });

    res.status(201).json({
      ok: true,
      message: "Donation metadata stored successfully.",
      recordId: record._id.toString(),
      dataHash,
      donation: serializeDonation(record, req)
    });
  } catch (error) {
    if (savedFile?.targetPath) {
      await fs.unlink(savedFile.targetPath).catch(() => {});
    }

    next(error);
  }
});

app.patch("/api/donations/:recordId/link-chain", async (req, res, next) => {
  try {
    const donationId = Number.parseInt(req.body?.donationId, 10);
    const record = await loadDonationRecord(req.params.recordId);

    if (!Number.isInteger(donationId) || donationId <= 0) {
      res.status(400).json({ ok: false, message: "A valid blockchain donation id is required." });
      return;
    }

    if (!record) {
      res.status(404).json({ ok: false, message: "Donation record not found in MongoDB." });
      return;
    }

    record.blockchainDonationId = donationId;
    await record.save();

    res.json({
      ok: true,
      message: "MongoDB donation linked to the blockchain record.",
      donation: serializeDonation(record, req)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/donations/:recordId/verify", async (req, res, next) => {
  try {
    const record = await loadDonationRecord(req.params.recordId);

    if (!record) {
      res.status(404).json({ ok: false, message: "Donation record not found in MongoDB." });
      return;
    }

    const onChainDataHash = parseRequiredHash(req.body?.dataHash, "Donation hash");
    const onChainRequestHash = sanitizeText(req.body?.requestHash)
      ? parseRequiredHash(req.body?.requestHash, "Request hash")
      : ZERO_HASH;
    const verification = await verifyDonationRecordAgainstHashes(record, {
      onChainDataHash,
      onChainRequestHash
    });

    res.json({
      ok: true,
      verification
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/donations/:recordId/unlinked", async (req, res, next) => {
  try {
    const record = await loadDonationRecord(req.params.recordId);

    if (!record) {
      res.status(404).json({ ok: false, message: "Donation record not found in MongoDB." });
      return;
    }

    if (record.blockchainDonationId !== null) {
      res.status(409).json({ ok: false, message: "Linked donation records cannot be deleted through this cleanup route." });
      return;
    }

    await deleteStoredImage(record.imageFilename);
    await record.deleteOne();

    res.json({
      ok: true,
      message: "Unlinked MongoDB donation draft removed."
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/donations/:recordId/claim-request/prepare", async (req, res, next) => {
  try {
    const record = await loadDonationRecord(req.params.recordId);
    ensureLinkedDonation(record);
    assertDonationNotExpired(record);

    const receiverAddress = sanitizeText(req.body.receiverAddress);
    let organizationName = sanitizeText(req.body.organizationName);
    let contactNumber = sanitizeText(req.body.contactNumber);

    if (!ethers.isAddress(receiverAddress)) {
      res.status(400).json({ ok: false, message: "A valid receiver wallet address is required." });
      return;
    }

    const normalizedReceiverAddress = ethers.getAddress(receiverAddress);

    if (normalizedReceiverAddress === record.donorAddress) {
      res.status(400).json({ ok: false, message: "The donor cannot request their own donation." });
      return;
    }

    if (record.currentRequest?.completed) {
      res.status(409).json({ ok: false, message: "This donation is already completed." });
      return;
    }

    if (record.currentRequest?.status === REQUEST_STATUS.PENDING) {
      res.status(409).json({ ok: false, message: "A receiver request is already pending for this donation." });
      return;
    }

    if (record.currentRequest?.status === REQUEST_STATUS.ACCEPTED && !record.currentRequest.completed) {
      res.status(409).json({ ok: false, message: "This donation has already been accepted by a receiver." });
      return;
    }

    const existingProfile = await ReceiverProfile.findOne({ walletAddress: normalizedReceiverAddress });
    organizationName = organizationName || sanitizeText(existingProfile?.organizationName);
    contactNumber = contactNumber || sanitizeText(existingProfile?.contactNumber);

    if (!organizationName || !contactNumber) {
      res.status(400).json({ ok: false, message: "Receiver organization name and contact number are required." });
      return;
    }

    const receiverRatingBasisPoints = Number.isInteger(existingProfile?.averageRatingBasisPoints)
      ? existingProfile.averageRatingBasisPoints
      : 0;
    const requestHash = computeClaimRequestHash({
      donationId: record.blockchainDonationId,
      donorAddress: record.donorAddress,
      receiverAddress: normalizedReceiverAddress,
      organizationName,
      contactNumber,
      receiverRatingBasisPoints,
      status: REQUEST_STATUS.PENDING,
      completed: false,
      donorRating: 0
    });

    res.json({
      ok: true,
      message: "Claim request prepared successfully.",
      request: {
        receiverAddress: normalizedReceiverAddress,
        organizationName,
        contactNumber,
        receiverRatingBasisPoints,
        donorRating: null,
        status: REQUEST_STATUS.PENDING,
        completed: false,
        requestHash
      }
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/donations/:recordId/claim-request/finalize", async (req, res, next) => {
  try {
    const record = await loadDonationRecord(req.params.recordId);
    ensureLinkedDonation(record);
    assertDonationNotExpired(record);

    const receiverAddress = sanitizeText(req.body.receiverAddress);
    const organizationName = sanitizeText(req.body.organizationName);
    const contactNumber = sanitizeText(req.body.contactNumber);
    const requestHash = sanitizeText(req.body.requestHash);

    if (!ethers.isAddress(receiverAddress)) {
      res.status(400).json({ ok: false, message: "A valid receiver wallet address is required." });
      return;
    }

    if (!organizationName || !contactNumber || !requestHash) {
      res.status(400).json({ ok: false, message: "Receiver request details are incomplete." });
      return;
    }

    const receiverRatingBasisPoints = parseReceiverRatingBasisPoints(
      req.body.receiverRatingBasisPoints
    );
    const normalizedReceiverAddress = ethers.getAddress(receiverAddress);
    const expectedRequestHash = computeClaimRequestHash({
      donationId: record.blockchainDonationId,
      donorAddress: record.donorAddress,
      receiverAddress: normalizedReceiverAddress,
      organizationName,
      contactNumber,
      receiverRatingBasisPoints,
      status: REQUEST_STATUS.PENDING,
      completed: false,
      donorRating: 0
    });

    if (requestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
      res.status(400).json({ ok: false, message: "The provided pending request hash is invalid." });
      return;
    }

    await upsertReceiverProfile({
      receiverAddress: normalizedReceiverAddress,
      organizationName,
      contactNumber
    });

    record.currentRequest = {
      receiverAddress: normalizedReceiverAddress,
      organizationName,
      contactNumber,
      receiverRatingBasisPoints,
      donorRating: null,
      status: REQUEST_STATUS.PENDING,
      completed: false,
      requestHash: expectedRequestHash,
      requestedAt: new Date(),
      reviewedAt: null,
      completedAt: null
    };
    await record.save();

    res.json({
      ok: true,
      message: "Receiver request saved to MongoDB.",
      donation: serializeDonation(record, req)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/donations/:recordId/claim-request/review/prepare", async (req, res, next) => {
  try {
    const record = await loadDonationRecord(req.params.recordId);
    ensureLinkedDonation(record);
    assertDonationNotExpired(record);

    if (typeof req.body.approve !== "boolean") {
      res.status(400).json({ ok: false, message: "Approval decision must be true or false." });
      return;
    }

    if (!record.currentRequest || record.currentRequest.status !== REQUEST_STATUS.PENDING) {
      res.status(409).json({ ok: false, message: "There is no pending receiver request to review." });
      return;
    }

    const status = req.body.approve ? REQUEST_STATUS.ACCEPTED : REQUEST_STATUS.REJECTED;
    const requestHash = computeClaimRequestHash({
      donationId: record.blockchainDonationId,
      donorAddress: record.donorAddress,
      receiverAddress: record.currentRequest.receiverAddress,
      organizationName: record.currentRequest.organizationName,
      contactNumber: record.currentRequest.contactNumber,
      receiverRatingBasisPoints: record.currentRequest.receiverRatingBasisPoints,
      status,
      completed: false,
      donorRating: 0
    });

    res.json({
      ok: true,
      message: "Receiver review prepared successfully.",
      request: {
        ...serializeClaimRequest(record.currentRequest),
        donorRating: null,
        status,
        completed: false,
        requestHash
      }
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/donations/:recordId/claim-request/review/finalize", async (req, res, next) => {
  try {
    const record = await loadDonationRecord(req.params.recordId);
    ensureLinkedDonation(record);
    assertDonationNotExpired(record);

    if (typeof req.body.approve !== "boolean") {
      res.status(400).json({ ok: false, message: "Approval decision must be true or false." });
      return;
    }

    if (!record.currentRequest || record.currentRequest.status !== REQUEST_STATUS.PENDING) {
      res.status(409).json({ ok: false, message: "There is no pending receiver request to finalize." });
      return;
    }

    const requestHash = sanitizeText(req.body.requestHash);
    const status = req.body.approve ? REQUEST_STATUS.ACCEPTED : REQUEST_STATUS.REJECTED;
    const expectedRequestHash = computeClaimRequestHash({
      donationId: record.blockchainDonationId,
      donorAddress: record.donorAddress,
      receiverAddress: record.currentRequest.receiverAddress,
      organizationName: record.currentRequest.organizationName,
      contactNumber: record.currentRequest.contactNumber,
      receiverRatingBasisPoints: record.currentRequest.receiverRatingBasisPoints,
      status,
      completed: false,
      donorRating: 0
    });

    if (!requestHash || requestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
      res.status(400).json({ ok: false, message: "The provided review hash is invalid." });
      return;
    }

    record.currentRequest.status = status;
    record.currentRequest.completed = false;
    record.currentRequest.donorRating = null;
    record.currentRequest.requestHash = expectedRequestHash;
    record.currentRequest.reviewedAt = new Date();
    record.currentRequest.completedAt = null;
    await record.save();

    res.json({
      ok: true,
      message: req.body.approve
        ? "Receiver request accepted and saved."
        : "Receiver request rejected and saved.",
      donation: serializeDonation(record, req)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/donations/:recordId/claim-request/complete/prepare", async (req, res, next) => {
  try {
    const record = await loadDonationRecord(req.params.recordId);
    ensureLinkedDonation(record);

    if (!record.currentRequest || record.currentRequest.status !== REQUEST_STATUS.ACCEPTED) {
      res.status(409).json({ ok: false, message: "Only accepted requests can be completed." });
      return;
    }

    if (record.currentRequest.completed) {
      res.status(409).json({ ok: false, message: "This delivery has already been completed." });
      return;
    }

    const donorRating = parseRating(req.body.donorRating);
    const requestHash = computeClaimRequestHash({
      donationId: record.blockchainDonationId,
      donorAddress: record.donorAddress,
      receiverAddress: record.currentRequest.receiverAddress,
      organizationName: record.currentRequest.organizationName,
      contactNumber: record.currentRequest.contactNumber,
      receiverRatingBasisPoints: record.currentRequest.receiverRatingBasisPoints,
      status: REQUEST_STATUS.ACCEPTED,
      completed: true,
      donorRating
    });

    res.json({
      ok: true,
      message: "Delivery completion prepared successfully.",
      request: {
        ...serializeClaimRequest(record.currentRequest),
        donorRating,
        completed: true,
        requestHash
      }
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/donations/:recordId/claim-request/complete/finalize", async (req, res, next) => {
  try {
    const record = await loadDonationRecord(req.params.recordId);
    ensureLinkedDonation(record);

    if (!record.currentRequest || record.currentRequest.status !== REQUEST_STATUS.ACCEPTED) {
      res.status(409).json({ ok: false, message: "Only accepted requests can be finalized as completed." });
      return;
    }

    if (record.currentRequest.completed) {
      res.status(409).json({ ok: false, message: "This delivery has already been completed." });
      return;
    }

    const donorRating = parseRating(req.body.donorRating);
    const requestHash = sanitizeText(req.body.requestHash);
    const expectedRequestHash = computeClaimRequestHash({
      donationId: record.blockchainDonationId,
      donorAddress: record.donorAddress,
      receiverAddress: record.currentRequest.receiverAddress,
      organizationName: record.currentRequest.organizationName,
      contactNumber: record.currentRequest.contactNumber,
      receiverRatingBasisPoints: record.currentRequest.receiverRatingBasisPoints,
      status: REQUEST_STATUS.ACCEPTED,
      completed: true,
      donorRating
    });

    if (!requestHash || requestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
      res.status(400).json({ ok: false, message: "The provided completion hash is invalid." });
      return;
    }

    record.currentRequest.donorRating = donorRating;
    record.currentRequest.completed = true;
    record.currentRequest.requestHash = expectedRequestHash;
    record.currentRequest.completedAt = new Date();
    await record.save();

    await applyReceiverRating({
      receiverAddress: record.currentRequest.receiverAddress,
      organizationName: record.currentRequest.organizationName,
      contactNumber: record.currentRequest.contactNumber,
      donorRating
    });

    res.json({
      ok: true,
      message: "Delivery completion and receiver rating saved.",
      donation: serializeDonation(record, req)
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ ok: false, message: "Image size must be 5 MB or smaller." });
    return;
  }

  const statusCode = error?.statusCode || 500;
  const message = error?.message || "Internal server error.";

  res.status(statusCode).json({
    ok: false,
    message
  });
});

async function startServer() {
  await mongoose.connect(mongoUri);
  app.listen(port, () => {
    console.log(`FoodVerse backend running on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start FoodVerse backend:", error);
  process.exitCode = 1;
});
