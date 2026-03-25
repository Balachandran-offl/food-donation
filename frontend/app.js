const CONTRACT_ADDRESS = "0xDA9B1D01001AE2E78Aa5746591709648CcF66d63";
const API_BASE_URL = "http://localhost:4000/api";
const ZERO_HASH = `0x${"0".repeat(64)}`;

const REQUEST_STATUS = Object.freeze({
  NONE: "none",
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected"
});

const REQUEST_STATUS_CODE = Object.freeze({
  [REQUEST_STATUS.PENDING]: 1,
  [REQUEST_STATUS.ACCEPTED]: 2,
  [REQUEST_STATUS.REJECTED]: 3
});

const CONTRACT_ABI = [
  "event DonationAdded(uint256 indexed id, address indexed donor, bytes32 dataHash)",
  "event ClaimRequestSubmitted(uint256 indexed id, address indexed receiver, bytes32 requestHash)",
  "event ClaimRequestReviewed(uint256 indexed id, address indexed donor, address indexed receiver, bool approved, bytes32 requestHash)",
  "event DeliveryCompleted(uint256 indexed id, address indexed receiver, bytes32 requestHash)",
  "function addDonation(bytes32 _dataHash)",
  "function requestClaim(uint256 _id, bytes32 _requestHash)",
  "function reviewClaimRequest(uint256 _id, bool _approve, bytes32 _requestHash)",
  "function completeDelivery(uint256 _id, bytes32 _requestHash)",
  "function donationCount() view returns (uint256)",
  "function donations(uint256) view returns (uint256 id, address donor, address receiver, bytes32 dataHash, bytes32 requestHash, uint8 requestStatus, bool claimed, bool completed)"
];

let provider = null;
let signer = null;
let contract = null;
let currentAccount = "";
let activeView = "donate";
let allDonations = [];

const verificationResults = {};
const imageHashCache = new Map();
const pendingLinkRepairs = new Set();

const connectBtn = document.getElementById("connectBtn");
const refreshBtn = document.getElementById("refreshBtn");
const donationForm = document.getElementById("donationForm");
const walletInfo = document.getElementById("walletInfo");
const networkInfo = document.getElementById("networkInfo");
const statusBox = document.getElementById("statusBox");
const donateTab = document.getElementById("donateTab");
const receiveTab = document.getElementById("receiveTab");
const donateView = document.getElementById("donateView");
const receiveView = document.getElementById("receiveView");
const locationFilter = document.getElementById("locationFilter");
const myDonationsContainer = document.getElementById("myDonationsContainer");
const receiveDonationsContainer = document.getElementById("receiveDonationsContainer");
const claimedByMeContainer = document.getElementById("claimedByMeContainer");
const imagePreview = document.getElementById("imagePreview");
const foodImageInput = document.getElementById("foodImage");
const expiryAtInput = document.getElementById("expiryAt");

const totalDonations = document.getElementById("totalDonations");
const availableDonations = document.getElementById("availableDonations");
const claimedDonations = document.getElementById("claimedDonations");
const completedDonations = document.getElementById("completedDonations");

function setStatus(message, type = "info") {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`;
}

function shortAddress(address) {
  if (!address || address === ethers.ZeroAddress) {
    return "Not assigned";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortHash(hash) {
  if (!hash || hash === ZERO_HASH) {
    return "Unavailable";
  }

  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function getExpiryTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isDonationExpired(item) {
  const expiryTimestamp = getExpiryTimestamp(item?.expiryAt);

  if (expiryTimestamp === null) {
    return Boolean(item?.isExpired);
  }

  return expiryTimestamp <= Date.now();
}

function formatExpiryDateTime(value) {
  const expiryTimestamp = getExpiryTimestamp(value);

  if (expiryTimestamp === null) {
    return "Not provided";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(expiryTimestamp));
}

function toDateTimeLocalValue(date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function updateExpiryInputMin() {
  if (!expiryAtInput) {
    return;
  }

  const minimumDate = new Date();
  minimumDate.setSeconds(0, 0);
  expiryAtInput.min = toDateTimeLocalValue(minimumDate);
}

function mapRequestStatus(statusCode) {
  if (Number(statusCode) === 1) return REQUEST_STATUS.PENDING;
  if (Number(statusCode) === 2) return REQUEST_STATUS.ACCEPTED;
  if (Number(statusCode) === 3) return REQUEST_STATUS.REJECTED;
  return REQUEST_STATUS.NONE;
}

function getRequestStatusCode(status) {
  return REQUEST_STATUS_CODE[status] || 0;
}

function getNetworkLabel(chainId) {
  if (chainId === "11155111") return "Sepolia";
  if (chainId === "31337") return "Hardhat Local";
  if (chainId === "1") return "Ethereum Mainnet";
  return "Custom Network";
}

function updateWalletInfo() {
  walletInfo.textContent = currentAccount
    ? `Wallet: ${shortAddress(currentAccount)}`
    : "Wallet not connected";

  connectBtn.textContent = currentAccount ? "Wallet Connected" : "Connect Wallet";
}

async function updateNetworkInfo() {
  if (!provider) return;

  const network = await provider.getNetwork();
  const chainId = network.chainId.toString();
  networkInfo.textContent = `${getNetworkLabel(chainId)} (${chainId})`;
}

function getWriteContract() {
  if (!signer) {
    throw new Error("Connect wallet first.");
  }

  return contract.connect(signer);
}

function setActiveView(view) {
  activeView = view;

  donateTab.classList.toggle("active", view === "donate");
  receiveTab.classList.toggle("active", view === "receive");
  donateView.classList.toggle("active", view === "donate");
  receiveView.classList.toggle("active", view === "receive");
}

function isCurrentUser(address) {
  return Boolean(
    currentAccount && address && normalizeText(address) === normalizeText(currentAccount)
  );
}

function isOpenForRequest(item) {
  return (
    item.metadataAvailable &&
    !item.completed &&
    !item.claimed &&
    !isDonationExpired(item) &&
    item.requestStatus !== REQUEST_STATUS.PENDING
  );
}

function getStatusClass(item) {
  if (item.completed) return "completed";
  if (item.claimed) return "claimed";
  if (isDonationExpired(item)) return "expired";
  if (item.requestStatus === REQUEST_STATUS.PENDING) return "pending";
  if (item.requestStatus === REQUEST_STATUS.REJECTED) return "rejected";
  return "available";
}

function getStatusLabel(item) {
  if (item.completed) return "Completed";
  if (item.claimed) return "Accepted";
  if (isDonationExpired(item)) return "Food Expired";
  if (item.requestStatus === REQUEST_STATUS.PENDING) return "Pending Review";
  if (item.requestStatus === REQUEST_STATUS.REJECTED) return "Rejected";
  return "Available";
}

function getVerificationResult(id, kind) {
  return verificationResults[id]?.[kind];
}

function isRequestHashVerified(id) {
  return getVerificationResult(String(id), "request") === true;
}

function getHashStatusMarkup(kind, id, isAvailable, label) {
  if (!isAvailable) {
    return `<span class="hash-pill unavailable">${escapeHtml(label)} unavailable</span>`;
  }

  const result = getVerificationResult(id, kind);

  if (result === undefined) {
    return `<span class="hash-pill pending">${escapeHtml(label)} pending</span>`;
  }

  if (result) {
    return `<span class="hash-pill verified">${escapeHtml(label)} verified</span>`;
  }

  return `<span class="hash-pill invalid">${escapeHtml(label)} mismatch</span>`;
}

function updateStats(items) {
  totalDonations.textContent = items.length;
  availableDonations.textContent = items.filter(isOpenForRequest).length;
  claimedDonations.textContent = items.filter((item) => item.claimed && !item.completed).length;
  completedDonations.textContent = items.filter((item) => item.completed).length;
}

function buildImageMarkup(item) {
  if (!item.imageUrl) {
    return `
      <div class="card-media">
        <div class="card-media-fallback">Image unavailable for this donation.</div>
      </div>
    `;
  }

  return `
    <div class="card-media">
      <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.foodType)}" loading="lazy" />
    </div>
  `;
}

function formatRating(basisPoints) {
  const normalized = Number(basisPoints || 0) / 100;

  if (!normalized) {
    return "New receiver";
  }

  return `${normalized.toFixed(Number.isInteger(normalized) ? 1 : 2)}/5`;
}

function buildStatusPills(item, showVerify) {
  const pills = [
    `<span class="status-pill ${getStatusClass(item)}">${getStatusLabel(item)}</span>`
  ];

  if (showVerify) {
    pills.push(getHashStatusMarkup("donation", item.id, item.metadataAvailable, "Donation hash"));

    if (item.requestHash !== ZERO_HASH) {
      pills.push(
        getHashStatusMarkup(
          "request",
          item.id,
          Boolean(item.currentRequest),
          "Request hash"
        )
      );
    }
  }

  return pills.join("");
}

function getVisibleReceiverLabel(item, viewer) {
  if (item.claimed || item.completed) {
    return shortAddress(item.receiver);
  }

  if (viewer === "donor" || isCurrentUser(item.currentRequest?.receiverAddress)) {
    return shortAddress(item.currentRequest?.receiverAddress || item.receiver);
  }

  return "Not assigned";
}

function buildRequestSummary(item, viewer) {
  const request = item.currentRequest;

  if (!request) {
    return "";
  }

  if (viewer !== "donor" && !isCurrentUser(request.receiverAddress)) {
    return "";
  }

  const donorRatingMarkup =
    Number.isInteger(request.donorRating) && request.donorRating > 0
      ? `
        <div class="request-meta-box">
          <span>Donor Rating</span>
          <strong>${escapeHtml(request.donorRating)}/5</strong>
        </div>
      `
      : "";

  return `
    <section class="request-panel">
      <div class="request-panel-head">
        <div>
          <p class="section-tag">Receiver Request</p>
          <h5>Receiver details</h5>
        </div>
      </div>

      <div class="request-meta-grid">
        <div class="request-meta-box">
          <span>Receiver Wallet</span>
          <strong>${escapeHtml(shortAddress(request.receiverAddress))}</strong>
        </div>
        <div class="request-meta-box">
          <span>Organization</span>
          <strong>${escapeHtml(request.organizationName)}</strong>
        </div>
        <div class="request-meta-box">
          <span>Receiver Contact</span>
          <strong>${escapeHtml(request.contactNumber)}</strong>
        </div>
        <div class="request-meta-box">
          <span>Current Receiver Rating</span>
          <strong>${escapeHtml(formatRating(request.receiverRatingBasisPoints))}</strong>
        </div>
        <div class="request-meta-box">
          <span>Request State</span>
          <strong>${escapeHtml(getStatusLabel(item))}</strong>
        </div>
        <div class="request-meta-box">
          <span>Stored Request Hash</span>
          <strong>${escapeHtml(shortHash(item.requestHash))}</strong>
        </div>
        ${donorRatingMarkup}
      </div>
    </section>
  `;
}

function buildReceiverRequestForm(item) {
  if (isDonationExpired(item)) {
    return `
      <section class="request-panel request-panel-expired">
        <div class="request-panel-head">
          <div>
            <p class="section-tag">Food Status</p>
            <h5>Food expired</h5>
          </div>
        </div>

        <p class="request-note">
          This donation reached its expiry date and time. Receiver requests are disabled.
        </p>
      </section>
    `;
  }

  const isRejectedForCurrentReceiver =
    item.requestStatus === REQUEST_STATUS.REJECTED &&
    isCurrentUser(item.currentRequest?.receiverAddress);
  const organizationName = isRejectedForCurrentReceiver
    ? item.currentRequest?.organizationName || ""
    : "";
  const contactNumber = isRejectedForCurrentReceiver
    ? item.currentRequest?.contactNumber || ""
    : "";
  const message = isRejectedForCurrentReceiver
    ? "Your last request was rejected. You can update the details and send a new request."
    : "Send a request to the donor. Your organization, contact number, and current receiver rating will be attached.";

  return `
    <section class="request-panel">
      <div class="request-panel-head">
        <div>
          <p class="section-tag">Send Request</p>
          <h5>Ask the donor to approve you</h5>
        </div>
      </div>

      <p class="request-note">${escapeHtml(message)}</p>

      <div class="request-form-grid">
        <div class="request-field">
          <label for="requestOrg-${escapeHtml(item.id)}">Organization Name</label>
          <input
            id="requestOrg-${escapeHtml(item.id)}"
            type="text"
            data-request-organization
            value="${escapeHtml(organizationName)}"
            placeholder="NGO, shelter, kitchen, volunteer team"
          />
        </div>

        <div class="request-field">
          <label for="requestContact-${escapeHtml(item.id)}">Receiver Contact</label>
          <input
            id="requestContact-${escapeHtml(item.id)}"
            type="tel"
            data-request-contact
            value="${escapeHtml(contactNumber)}"
            placeholder="+91 90000 00000"
          />
        </div>
      </div>

      <div class="request-actions">
        <button type="button" data-action="request" data-id="${escapeHtml(item.id)}">
          Send Request
        </button>
      </div>
    </section>
  `;
}

function buildDonorControlPanel(item) {
  const request = item.currentRequest;

  if (isDonationExpired(item) && !item.claimed && !item.completed) {
    const expiredMessage =
      item.requestStatus === REQUEST_STATUS.PENDING
        ? "This food has expired, so the pending receiver request can no longer be approved."
        : "This food has expired, so new receiver requests are no longer allowed.";

    return `
      <section class="request-panel request-panel-expired">
        <p class="request-note">${escapeHtml(expiredMessage)}</p>
      </section>
    `;
  }

  if (!request) {
    return `
      <section class="request-panel request-panel-muted">
        <p class="request-note">No receiver requests have been submitted for this donation yet.</p>
      </section>
    `;
  }

  if (item.requestStatus === REQUEST_STATUS.PENDING) {
    const requestVerified = isRequestHashVerified(item.id);
    const reviewMessage = requestVerified
      ? "Request hash verified. You can now accept or reject the request."
      : "Verify the request hash first. Accept and reject stay locked until verification succeeds.";

    return `
      <section class="request-panel">
        <p class="request-note">${escapeHtml(reviewMessage)}</p>
        <div class="request-actions">
          <button type="button" data-action="approve" data-id="${escapeHtml(item.id)}" ${requestVerified ? "" : "disabled"}>
            Accept Request
          </button>
          <button type="button" data-action="reject" data-id="${escapeHtml(item.id)}" class="btn-danger-soft" ${requestVerified ? "" : "disabled"}>
            Reject Request
          </button>
        </div>
      </section>
    `;
  }

  if (item.requestStatus === REQUEST_STATUS.REJECTED) {
    return `
      <section class="request-panel request-panel-muted">
        <p class="request-note">This request was rejected. The donation is open for a new receiver request.</p>
      </section>
    `;
  }

  if (item.claimed && !item.completed) {
    return `
      <section class="request-panel">
        <div class="request-panel-head">
          <div>
            <p class="section-tag">Complete Delivery</p>
            <h5>Rate the receiver after handoff</h5>
          </div>
        </div>

        <p class="request-note">
          Once the food is delivered, choose a rating for the receiver and complete the delivery on-chain.
        </p>

        <div class="request-form-grid">
          <div class="request-field">
            <label for="completeRating-${escapeHtml(item.id)}">Receiver Rating</label>
            <select id="completeRating-${escapeHtml(item.id)}" data-complete-rating>
              <option value="5">5 - Excellent</option>
              <option value="4">4 - Good</option>
              <option value="3">3 - Average</option>
              <option value="2">2 - Needs Improvement</option>
              <option value="1">1 - Poor</option>
            </select>
          </div>
        </div>

        <div class="request-actions">
          <button type="button" data-action="complete" data-id="${escapeHtml(item.id)}">
            Complete Delivery
          </button>
        </div>
      </section>
    `;
  }

  return `
    <section class="request-panel request-panel-muted">
      <p class="request-note">
        Delivery completed${Number.isInteger(request.donorRating) ? ` and the receiver was rated ${request.donorRating}/5.` : "."}
      </p>
    </section>
  `;
}

function buildReceiverStatusPanel(item) {
  const request = item.currentRequest;

  if (!request || !isCurrentUser(request.receiverAddress)) {
    return "";
  }

  let message =
    "Your request is stored in MongoDB and anchored to the active request hash on-chain.";

  if (item.requestStatus === REQUEST_STATUS.PENDING) {
    message = "Your request is waiting for donor approval.";
  }

  if (item.requestStatus === REQUEST_STATUS.ACCEPTED && !item.completed) {
    message = "Your request accepted. Coordinate pickup with the donor.";
  }

  if (item.requestStatus === REQUEST_STATUS.REJECTED) {
    message = "Your request rejected. You can update your details and send another request.";
  }

  if (isDonationExpired(item) && !item.completed && item.requestStatus !== REQUEST_STATUS.ACCEPTED) {
    message = "This food has expired. The donation can no longer accept receiver requests.";
  }

  if (item.completed) {
    message = Number.isInteger(request.donorRating)
      ? `Delivery completed. The donor rated your organization ${request.donorRating}/5.`
      : "Delivery completed successfully.";
  }

  return `
    <section class="request-panel request-panel-muted">
      <p class="request-note">${escapeHtml(message)}</p>
    </section>
  `;
}

function buildVerifyAction(item, showVerify) {
  if (!showVerify) {
    return "";
  }

  return `
    <div class="card-actions">
      <button type="button" data-action="verify" data-id="${escapeHtml(item.id)}">Verify Hash</button>
    </div>
  `;
}

function buildDonationCard(item, options = {}) {
  const viewer = options.viewer || "receiver";
  const extraSections = [];

  if (viewer === "donor") {
    extraSections.push(buildRequestSummary(item, "donor"));
    extraSections.push(buildDonorControlPanel(item));
  }

  if (viewer === "receiver-open") {
    if (item.currentRequest && isCurrentUser(item.currentRequest.receiverAddress)) {
      extraSections.push(buildRequestSummary(item, "receiver"));
    }

    extraSections.push(buildReceiverRequestForm(item));
  }

  if (viewer === "receiver-request") {
    extraSections.push(buildRequestSummary(item, "receiver"));
    extraSections.push(buildReceiverStatusPanel(item));
  }

  return `
    <article class="donation-card">
      <div class="donation-head">
        <div>
          <h4 class="donation-title">${escapeHtml(item.foodType || "Metadata unavailable")}</h4>
          <p class="donation-subtitle">
            Serves <strong>${escapeHtml(item.quantity ?? "N/A")}</strong> people in
            <strong>${escapeHtml(item.location || "Unknown location")}</strong>
          </p>
        </div>

        <div class="pill-row">
          ${buildStatusPills(item, options.showVerify === true)}
        </div>
      </div>

      ${buildImageMarkup(item)}

      <div class="meta-grid">
        <div class="meta-box">
          <span>Donation ID</span>
          <strong>#${escapeHtml(item.id)}</strong>
        </div>
        <div class="meta-box">
          <span>Stored Donation Hash</span>
          <strong>${escapeHtml(shortHash(item.dataHash))}</strong>
        </div>
        <div class="meta-box">
          <span>Donor</span>
          <strong>${escapeHtml(shortAddress(item.donor))}</strong>
        </div>
        <div class="meta-box">
          <span>Receiver</span>
          <strong>${escapeHtml(getVisibleReceiverLabel(item, viewer))}</strong>
        </div>
        <div class="meta-box">
          <span>Pickup Location</span>
          <strong>${escapeHtml(item.location || "Unavailable")}</strong>
        </div>
        <div class="meta-box">
          <span>Expiry Date & Time</span>
          <strong>${escapeHtml(formatExpiryDateTime(item.expiryAt))}</strong>
        </div>
        <div class="meta-box">
          <span>Donor Contact</span>
          <strong>${escapeHtml(item.contactNumber || "Unavailable")}</strong>
        </div>
      </div>

      ${extraSections.join("")}
      ${buildVerifyAction(item, options.showVerify === true)}
    </article>
  `;
}

function renderEmpty(container, message) {
  container.innerHTML = `<div class="empty-box">${escapeHtml(message)}</div>`;
}

function renderMyDonations() {
  if (!currentAccount) {
    renderEmpty(myDonationsContainer, "Connect your wallet to see donations published from your account.");
    return;
  }

  const myDonations = allDonations.filter(
    (item) => normalizeText(item.donor) === normalizeText(currentAccount)
  );

  if (!myDonations.length) {
    renderEmpty(myDonationsContainer, "You have not published any donations yet.");
    return;
  }

  myDonationsContainer.innerHTML = myDonations
    .map((item) =>
      buildDonationCard(item, {
        viewer: "donor",
        showVerify: true
      })
    )
    .join("");
}

function renderReceiveDonations() {
  const filterText = normalizeText(locationFilter.value);

  const filtered = allDonations.filter((item) => {
    const shouldShowToReceiver =
      item.metadataAvailable &&
      !item.completed &&
      !item.claimed &&
      (item.requestStatus !== REQUEST_STATUS.PENDING || isDonationExpired(item));

    if (!shouldShowToReceiver) {
      return false;
    }

    if (!filterText) {
      return true;
    }

    return normalizeText(item.location).includes(filterText);
  });

  if (!filtered.length) {
    renderEmpty(
      receiveDonationsContainer,
      filterText
        ? "No available or expired foods match this location filter."
        : "No donations are currently available for new receiver requests."
    );
    return;
  }

  receiveDonationsContainer.innerHTML = filtered
    .map((item) =>
      buildDonationCard(item, {
        viewer: "receiver-open",
        showVerify: true
      })
    )
    .join("");
}

function renderClaimedByMe() {
  if (!currentAccount) {
    renderEmpty(claimedByMeContainer, "Connect your wallet to track the requests sent from your account.");
    return;
  }

  const myRequests = allDonations.filter((item) =>
    normalizeText(item.currentRequest?.receiverAddress) === normalizeText(currentAccount)
  );

  if (!myRequests.length) {
    renderEmpty(claimedByMeContainer, "You have not sent any food requests yet.");
    return;
  }

  claimedByMeContainer.innerHTML = myRequests
    .map((item) =>
      buildDonationCard(item, {
        viewer: "receiver-request",
        showVerify: true
      })
    )
    .join("");
}

function renderAllSections() {
  renderMyDonations();
  renderReceiveDonations();
  renderClaimedByMe();
}

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.message || `Request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}

async function linkDonationRecord(recordId, donationId) {
  const response = await fetch(`${API_BASE_URL}/donations/${recordId}/link-chain`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      donationId
    })
  });

  return parseApiResponse(response);
}

async function repairDonationLink(record, donationId) {
  if (!record?.recordId || Number.isInteger(record.blockchainDonationId)) {
    return;
  }

  const repairKey = `${record.recordId}:${donationId}`;

  if (pendingLinkRepairs.has(repairKey)) {
    return;
  }

  pendingLinkRepairs.add(repairKey);

  try {
    await linkDonationRecord(record.recordId, donationId);
  } catch (error) {
    console.warn(`Failed to relink MongoDB record ${record.recordId} to donation #${donationId}.`, error);
  } finally {
    pendingLinkRepairs.delete(repairKey);
  }
}

async function ensureDonationRecordLinked(donation) {
  if (!donation?.recordId) {
    throw new Error(`Donation #${donation?.id || "unknown"} is missing its MongoDB record.`);
  }

  if (Number.isInteger(donation.blockchainDonationId)) {
    return donation.blockchainDonationId;
  }

  await linkDonationRecord(donation.recordId, donation.id);
  donation.blockchainDonationId = Number(donation.id);

  return donation.blockchainDonationId;
}

async function fetchDonationMetadata(location = "") {
  const url = new URL(`${API_BASE_URL}/donations`);

  if (location) {
    url.searchParams.set("location", location);
  }

  const response = await fetch(url.toString());
  const payload = await parseApiResponse(response);

  return payload.donations || [];
}

function getReadableError(error) {
  return (
    error?.shortMessage ||
    error?.reason ||
    error?.info?.error?.message ||
    error?.message ||
    "Something went wrong."
  );
}

function computeDonationHash(donation, imageHash) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const expiryTimestamp = getExpiryTimestamp(donation.expiryAt);

  if (expiryTimestamp !== null) {
    return ethers.keccak256(
      abiCoder.encode(
        ["address", "string", "uint256", "string", "string", "uint256", "bytes32"],
        [
          donation.donor,
          donation.foodType,
          BigInt(donation.quantity),
          donation.location,
          donation.contactNumber,
          BigInt(expiryTimestamp),
          imageHash
        ]
      )
    );
  }

  return ethers.keccak256(
    abiCoder.encode(
      ["address", "string", "uint256", "string", "string", "bytes32"],
      [
        donation.donor,
        donation.foodType,
        BigInt(donation.quantity),
        donation.location,
        donation.contactNumber,
        imageHash
      ]
    )
  );
}

function computeClaimRequestHash(donation, request) {
  if (!request) {
    return ZERO_HASH;
  }

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  return ethers.keccak256(
    abiCoder.encode(
      ["uint256", "address", "address", "string", "string", "uint256", "uint8", "bool", "uint256"],
      [
        BigInt(donation.id),
        donation.donor,
        request.receiverAddress,
        request.organizationName,
        request.contactNumber,
        BigInt(request.receiverRatingBasisPoints || 0),
        getRequestStatusCode(request.status),
        Boolean(request.completed),
        BigInt(request.donorRating || 0)
      ]
    )
  );
}

async function computeImageHashFromUrl(imageUrl) {
  if (imageHashCache.has(imageUrl)) {
    return imageHashCache.get(imageUrl);
  }

  const response = await fetch(imageUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Unable to download the food image for hash verification.");
  }

  const imageBytes = new Uint8Array(await response.arrayBuffer());
  const imageHash = ethers.keccak256(imageBytes);

  imageHashCache.set(imageUrl, imageHash);
  return imageHash;
}

async function verifyDonationLocally(donation) {
  const imageHash = await computeImageHashFromUrl(donation.imageUrl);
  const currentDonationHash = computeDonationHash(donation, imageHash);
  const legacyDonationHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "string", "uint256", "string", "string", "bytes32"],
      [
        donation.donor,
        donation.foodType,
        BigInt(donation.quantity),
        donation.location,
        donation.contactNumber,
        imageHash
      ]
    )
  );
  const normalizedOnChainHash = donation.dataHash.toLowerCase();
  const donationVerified =
    currentDonationHash.toLowerCase() === normalizedOnChainHash ||
    legacyDonationHash.toLowerCase() === normalizedOnChainHash;

  let requestVerified;

  if (donation.requestHash !== ZERO_HASH) {
    if (!donation.currentRequest) {
      requestVerified = false;
    } else {
      const recalculatedRequestHash = computeClaimRequestHash(donation, donation.currentRequest);
      requestVerified =
        recalculatedRequestHash.toLowerCase() === donation.requestHash.toLowerCase();
    }
  }

  return {
    donationVerified,
    requestVerified
  };
}

async function verifyDonationWithBackend(donation) {
  const response = await fetch(`${API_BASE_URL}/donations/${donation.recordId}/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      dataHash: donation.dataHash,
      requestHash: donation.requestHash
    })
  });
  const payload = await parseApiResponse(response);

  return payload.verification;
}

function extractDonationIdFromReceipt(receipt) {
  for (const log of receipt.logs) {
    try {
      const parsedLog = contract.interface.parseLog(log);

      if (parsedLog?.name === "DonationAdded") {
        return parsedLog.args.id.toString();
      }
    } catch (_error) {
      // Ignore non-contract logs while scanning the receipt.
    }
  }

  return null;
}

async function loadDonations() {
  try {
    if (!contract) return;

    setStatus("Loading blockchain state and MongoDB metadata...", "info");

    const [metadataRecords, rawCount] = await Promise.all([
      fetchDonationMetadata(),
      contract.donationCount()
    ]);

    const count = Number(rawCount);
    const ids = Array.from({ length: count }, (_, index) => BigInt(index + 1));
    const metadataByChainId = new Map();
    const metadataByHash = new Map();

    for (const record of metadataRecords) {
      if (Number.isInteger(record.blockchainDonationId)) {
        metadataByChainId.set(String(record.blockchainDonationId), record);
      }

      if (record.dataHash) {
        metadataByHash.set(String(record.dataHash).toLowerCase(), record);
      }
    }

    const repairTasks = [];

    const onChainItems = await Promise.all(
      ids.map(async (id) => {
        const donation = await contract.donations(id);
        const donationId = donation.id.toString();
        const donationHash = String(donation.dataHash).toLowerCase();
        let record =
          metadataByChainId.get(donationId) ||
          metadataByHash.get(donationHash) ||
          null;

        if (record && !Number.isInteger(record.blockchainDonationId) && record.recordId) {
          repairTasks.push(repairDonationLink(record, donationId));
        }

        const requestStatus = mapRequestStatus(donation.requestStatus);
        const currentRequest = record?.currentRequest
          ? {
              ...record.currentRequest,
              receiverAddress:
                donation.receiver && donation.receiver !== ethers.ZeroAddress
                  ? donation.receiver
                  : record.currentRequest.receiverAddress,
              status:
                requestStatus === REQUEST_STATUS.NONE
                  ? record.currentRequest.status
                  : requestStatus,
              completed: donation.completed || Boolean(record.currentRequest.completed)
            }
          : null;

        return {
          id: donation.id.toString(),
          donor: donation.donor,
          receiver: donation.receiver,
          dataHash: donation.dataHash,
          requestHash: donation.requestHash,
          requestStatus,
          claimed: donation.claimed,
          completed: donation.completed,
          blockchainDonationId: Number.isInteger(record?.blockchainDonationId)
            ? record.blockchainDonationId
            : null,
          metadataAvailable: Boolean(record),
          foodType: record?.foodType || "Metadata unavailable",
          quantity: record?.quantity ?? "N/A",
          location: record?.location || "Unavailable",
          contactNumber: record?.contactNumber || "Unavailable",
          expiryAt: record?.expiryAt || null,
          isExpired: Boolean(record?.isExpired),
          imageUrl: record?.imageUrl || "",
          imageMimeType: record?.imageMimeType || "",
          recordId: record?.recordId || null,
          currentRequest
        };
      })
    );

    if (repairTasks.length > 0) {
      await Promise.allSettled(repairTasks);
    }

    allDonations = onChainItems.reverse();
    updateStats(allDonations);
    renderAllSections();
    setStatus("FoodVerse data loaded successfully.", "success");
  } catch (error) {
    setStatus(getReadableError(error), "error");
  }
}

async function connectWallet() {
  try {
    if (!window.ethereum) {
      setStatus("MetaMask is not installed.", "error");
      return;
    }

    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    currentAccount = await signer.getAddress();

    updateWalletInfo();
    await updateNetworkInfo();
    renderAllSections();
    await loadDonations();

    setStatus("Wallet connected successfully.", "success");
  } catch (error) {
    setStatus(getReadableError(error), "error");
  }
}

async function addDonation(event) {
  event.preventDefault();

  let preparedRecordId = null;

  try {
    const foodType = document.getElementById("foodType").value.trim();
    const quantity = document.getElementById("quantity").value.trim();
    const location = document.getElementById("location").value.trim();
    const contactNumber = document.getElementById("contactNumber").value.trim();
    const expiryAtValue = expiryAtInput.value;
    const imageFile = foodImageInput.files[0];

    if (!signer) {
      setStatus("Connect wallet before publishing a donation.", "error");
      return;
    }

    if (!foodType || Number(quantity) <= 0 || !location || !contactNumber || !expiryAtValue) {
      setStatus("Fill in all donor fields before submitting.", "error");
      return;
    }

    const expiryTimestamp = getExpiryTimestamp(expiryAtValue);

    if (expiryTimestamp === null || expiryTimestamp <= Date.now()) {
      setStatus("Choose an expiry date and time in the future.", "error");
      return;
    }

    if (!imageFile) {
      setStatus("Select a food image before submitting.", "error");
      return;
    }

    const formData = new FormData();
    formData.append("donorAddress", currentAccount);
    formData.append("foodType", foodType);
    formData.append("quantity", quantity);
    formData.append("location", location);
    formData.append("contactNumber", contactNumber);
    formData.append("expiryAt", new Date(expiryTimestamp).toISOString());
    formData.append("image", imageFile);

    setStatus("Uploading donation metadata to MongoDB...", "info");

    const prepareResponse = await fetch(`${API_BASE_URL}/donations/prepare`, {
      method: "POST",
      body: formData
    });
    const preparedDonation = await parseApiResponse(prepareResponse);
    preparedRecordId = preparedDonation.recordId;

    const writeContract = getWriteContract();
    setStatus("Submitting donation hash to the blockchain...", "info");

    const tx = await writeContract.addDonation(preparedDonation.dataHash);
    const receipt = await tx.wait();
    const donationId =
      extractDonationIdFromReceipt(receipt) || (await contract.donationCount()).toString();

    await linkDonationRecord(preparedDonation.recordId, donationId);

    donationForm.reset();
    resetImagePreview();
    updateExpiryInputMin();
    setStatus("Donation stored in MongoDB and its hash was published on-chain.", "success");
    await loadDonations();
  } catch (error) {
    if (preparedRecordId) {
      await fetch(`${API_BASE_URL}/donations/${preparedRecordId}/unlinked`, {
        method: "DELETE"
      }).catch(() => {});
    }

    setStatus(getReadableError(error), "error");
  }
}

async function verifyDonation(id) {
  try {
    const donation = allDonations.find((item) => item.id === String(id));

    if (!donation) {
      setStatus(`Donation #${id} not found.`, "error");
      return;
    }

    if (!donation.metadataAvailable) {
      setStatus(`Donation #${id} cannot be verified because its MongoDB metadata is unavailable.`, "error");
      return;
    }

    setStatus(`Recalculating hashes for donation #${id}...`, "info");

    let donationVerified;
    let requestVerified;

    try {
      const verification = await verifyDonationWithBackend(donation);
      donationVerified = Boolean(verification?.donationVerified);
      requestVerified = verification?.requestVerified;
    } catch (error) {
      console.warn(`Backend verification failed for donation #${id}. Falling back to browser verification.`, error);
      const localVerification = await verifyDonationLocally(donation);
      donationVerified = localVerification.donationVerified;
      requestVerified = localVerification.requestVerified;
    }

    verificationResults[String(id)] = {
      donation: donationVerified,
      request: requestVerified
    };
    renderAllSections();

    const isSuccess = donationVerified && requestVerified !== false;
    const messages = [
      donationVerified ? "donation hash verified" : "donation hash mismatch"
    ];

    if (requestVerified === true) {
      messages.push("request hash verified");
    }

    if (requestVerified === false) {
      messages.push("request hash mismatch");
    }

    setStatus(`Donation #${id}: ${messages.join(", ")}.`, isSuccess ? "success" : "error");
  } catch (error) {
    setStatus(getReadableError(error), "error");
  }
}

async function requestDonation(id, button) {
  try {
    const donation = allDonations.find((item) => item.id === String(id));

    if (!donation) {
      setStatus(`Donation #${id} not found.`, "error");
      return;
    }

    if (!donation.recordId) {
      setStatus(`Donation #${id} is missing its MongoDB record.`, "error");
      return;
    }

    await ensureDonationRecordLinked(donation);

    if (isDonationExpired(donation)) {
      setStatus(`Donation #${id} food expired. Receiver requests are disabled.`, "error");
      return;
    }

    if (verificationResults[String(id)]?.donation !== true) {
      setStatus(`Verify donation #${id} before sending a receiver request.`, "error");
      return;
    }

    const card = button.closest(".donation-card");
    const organizationInput = card?.querySelector("[data-request-organization]");
    const contactInput = card?.querySelector("[data-request-contact]");
    const organizationName = organizationInput?.value.trim() || "";
    const contactNumber = contactInput?.value.trim() || "";

    if (!organizationName || !contactNumber) {
      setStatus("Receiver organization name and contact number are required.", "error");
      return;
    }

    const prepareResponse = await fetch(
      `${API_BASE_URL}/donations/${donation.recordId}/claim-request/prepare`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          receiverAddress: currentAccount,
          organizationName,
          contactNumber
        })
      }
    );
    const preparedRequest = await parseApiResponse(prepareResponse);

    const writeContract = getWriteContract();
    setStatus(`Submitting receiver request for donation #${id}...`, "info");

    const tx = await writeContract.requestClaim(
      BigInt(id),
      preparedRequest.request.requestHash
    );
    await tx.wait();

    const finalizeResponse = await fetch(
      `${API_BASE_URL}/donations/${donation.recordId}/claim-request/finalize`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...preparedRequest.request
        })
      }
    );
    await parseApiResponse(finalizeResponse);

    setStatus(`Receiver request sent for donation #${id}.`, "success");
    await loadDonations();
  } catch (error) {
    setStatus(getReadableError(error), "error");
  }
}

async function reviewRequest(id, approve) {
  try {
    const donation = allDonations.find((item) => item.id === String(id));

    if (!donation) {
      setStatus(`Donation #${id} not found.`, "error");
      return;
    }

    if (!donation.recordId) {
      setStatus(`Donation #${id} is missing its MongoDB record.`, "error");
      return;
    }

    if (!isRequestHashVerified(id)) {
      setStatus(`Verify the request hash for donation #${id} before accepting or rejecting it.`, "error");
      return;
    }

    await ensureDonationRecordLinked(donation);

    if (isDonationExpired(donation) && !donation.claimed && !donation.completed) {
      setStatus(`Donation #${id} food expired. This request can no longer be reviewed.`, "error");
      return;
    }

    const prepareResponse = await fetch(
      `${API_BASE_URL}/donations/${donation.recordId}/claim-request/review/prepare`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ approve })
      }
    );
    const preparedReview = await parseApiResponse(prepareResponse);

    const writeContract = getWriteContract();
    setStatus(
      `${approve ? "Accepting" : "Rejecting"} request for donation #${id}...`,
      "info"
    );

    const tx = await writeContract.reviewClaimRequest(
      BigInt(id),
      approve,
      preparedReview.request.requestHash
    );
    await tx.wait();

    const finalizeResponse = await fetch(
      `${API_BASE_URL}/donations/${donation.recordId}/claim-request/review/finalize`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          approve,
          requestHash: preparedReview.request.requestHash
        })
      }
    );
    await parseApiResponse(finalizeResponse);

    setStatus(
      approve
        ? `Receiver request accepted for donation #${id}.`
        : `Receiver request rejected for donation #${id}.`,
      "success"
    );
    await loadDonations();
  } catch (error) {
    setStatus(getReadableError(error), "error");
  }
}

async function completeDonation(id, button) {
  try {
    const donation = allDonations.find((item) => item.id === String(id));

    if (!donation) {
      setStatus(`Donation #${id} not found.`, "error");
      return;
    }

    if (!donation.recordId) {
      setStatus(`Donation #${id} is missing its MongoDB record.`, "error");
      return;
    }

    await ensureDonationRecordLinked(donation);

    const card = button.closest(".donation-card");
    const ratingValue = card?.querySelector("[data-complete-rating]")?.value;

    if (!ratingValue) {
      setStatus("Choose a receiver rating before completing delivery.", "error");
      return;
    }

    const donorRating = Number.parseInt(ratingValue, 10);
    const prepareResponse = await fetch(
      `${API_BASE_URL}/donations/${donation.recordId}/claim-request/complete/prepare`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ donorRating })
      }
    );
    const preparedCompletion = await parseApiResponse(prepareResponse);

    const writeContract = getWriteContract();
    setStatus(`Completing delivery for donation #${id}...`, "info");

    const tx = await writeContract.completeDelivery(
      BigInt(id),
      preparedCompletion.request.requestHash
    );
    await tx.wait();

    const finalizeResponse = await fetch(
      `${API_BASE_URL}/donations/${donation.recordId}/claim-request/complete/finalize`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          donorRating,
          requestHash: preparedCompletion.request.requestHash
        })
      }
    );
    await parseApiResponse(finalizeResponse);

    setStatus(`Donation #${id} marked as completed and receiver rated successfully.`, "success");
    await loadDonations();
  } catch (error) {
    setStatus(getReadableError(error), "error");
  }
}

async function handleDonationActions(event) {
  const button = event.target.closest("button[data-action]");

  if (!button) return;

  const { action, id } = button.dataset;

  if (action === "verify") {
    await verifyDonation(id);
  }

  if (action === "request") {
    await requestDonation(id, button);
  }

  if (action === "approve") {
    await reviewRequest(id, true);
  }

  if (action === "reject") {
    await reviewRequest(id, false);
  }

  if (action === "complete") {
    await completeDonation(id, button);
  }
}

function handleViewChange(event) {
  const button = event.target.closest("button[data-view]");

  if (!button) return;

  setActiveView(button.dataset.view);
}

function resetImagePreview() {
  imagePreview.classList.add("empty");
  imagePreview.innerHTML = "Image preview will appear here after you select a food photo.";
}

function handleImagePreview() {
  const file = foodImageInput.files[0];

  if (!file) {
    resetImagePreview();
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  imagePreview.classList.remove("empty");
  imagePreview.innerHTML = `<img src="${objectUrl}" alt="Food preview" />`;
}

async function init() {
  updateExpiryInputMin();

  if (!window.ethereum) {
    connectBtn.disabled = true;
    refreshBtn.disabled = true;
    setStatus("Install MetaMask to use this frontend.", "error");
    return;
  }

  if (CONTRACT_ADDRESS.includes("PASTE_NEW_DEPLOYED")) {
    setStatus("Redeploy the updated FoodDonation contract and paste the new address in app.js first.", "error");
    return;
  }

  provider = new ethers.BrowserProvider(window.ethereum);
  contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

  await updateNetworkInfo();

  const accounts = await provider.send("eth_accounts", []);
  if (accounts.length > 0) {
    signer = await provider.getSigner();
    currentAccount = accounts[0];
  }

  updateWalletInfo();
  renderAllSections();
  await loadDonations();

  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

connectBtn.addEventListener("click", connectWallet);
refreshBtn.addEventListener("click", loadDonations);
donationForm.addEventListener("submit", addDonation);
locationFilter.addEventListener("input", renderReceiveDonations);
foodImageInput.addEventListener("change", handleImagePreview);
myDonationsContainer.addEventListener("click", handleDonationActions);
receiveDonationsContainer.addEventListener("click", handleDonationActions);
claimedByMeContainer.addEventListener("click", handleDonationActions);
donateTab.addEventListener("click", handleViewChange);
receiveTab.addEventListener("click", handleViewChange);

setActiveView(activeView);
resetImagePreview();
updateExpiryInputMin();
window.setInterval(() => {
  updateStats(allDonations);
  renderAllSections();
}, 30000);
init();
