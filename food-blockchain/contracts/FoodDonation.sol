// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract FoodDonation {
    enum RequestStatus {
        None,
        Pending,
        Accepted,
        Rejected
    }

    struct Donation {
        uint256 id;
        address donor;
        address receiver;
        bytes32 dataHash;
        bytes32 requestHash;
        RequestStatus requestStatus;
        bool claimed;
        bool completed;
    }

    uint256 public donationCount = 0;
    mapping(uint256 => Donation) public donations;

    event DonationAdded(uint256 indexed id, address indexed donor, bytes32 dataHash);
    event ClaimRequestSubmitted(
        uint256 indexed id,
        address indexed receiver,
        bytes32 requestHash
    );
    event ClaimRequestReviewed(
        uint256 indexed id,
        address indexed donor,
        address indexed receiver,
        bool approved,
        bytes32 requestHash
    );
    event DeliveryCompleted(
        uint256 indexed id,
        address indexed receiver,
        bytes32 requestHash
    );

    function addDonation(bytes32 _dataHash) public {
        require(_dataHash != bytes32(0), "Hash required");

        donationCount++;

        donations[donationCount] = Donation({
            id: donationCount,
            donor: msg.sender,
            receiver: address(0),
            dataHash: _dataHash,
            requestHash: bytes32(0),
            requestStatus: RequestStatus.None,
            claimed: false,
            completed: false
        });

        emit DonationAdded(donationCount, msg.sender, _dataHash);
    }

    function requestClaim(uint256 _id, bytes32 _requestHash) public {
        require(_id > 0 && _id <= donationCount, "Invalid ID");
        require(_requestHash != bytes32(0), "Request hash required");

        Donation storage donation = donations[_id];

        require(!donation.completed, "Donation already completed");
        require(!donation.claimed, "Donation already accepted");
        require(
            donation.requestStatus != RequestStatus.Pending,
            "Claim request already pending"
        );
        require(msg.sender != donation.donor, "Donor cannot request own donation");

        donation.receiver = msg.sender;
        donation.requestHash = _requestHash;
        donation.requestStatus = RequestStatus.Pending;

        emit ClaimRequestSubmitted(_id, msg.sender, _requestHash);
    }

    function reviewClaimRequest(
        uint256 _id,
        bool _approve,
        bytes32 _requestHash
    ) public {
        require(_id > 0 && _id <= donationCount, "Invalid ID");
        require(_requestHash != bytes32(0), "Request hash required");

        Donation storage donation = donations[_id];

        require(msg.sender == donation.donor, "Only donor can review");
        require(
            donation.requestStatus == RequestStatus.Pending,
            "No pending request"
        );

        donation.requestHash = _requestHash;
        donation.claimed = _approve;
        donation.requestStatus = _approve
            ? RequestStatus.Accepted
            : RequestStatus.Rejected;

        emit ClaimRequestReviewed(
            _id,
            donation.donor,
            donation.receiver,
            _approve,
            _requestHash
        );
    }

    function completeDelivery(uint256 _id, bytes32 _requestHash) public {
        require(_id > 0 && _id <= donationCount, "Invalid ID");
        require(_requestHash != bytes32(0), "Request hash required");

        Donation storage donation = donations[_id];

        require(msg.sender == donation.donor, "Only donor can confirm");
        require(
            donation.requestStatus == RequestStatus.Accepted && donation.claimed,
            "Donation not accepted"
        );
        require(!donation.completed, "Already completed");

        donation.requestHash = _requestHash;
        donation.completed = true;

        emit DeliveryCompleted(_id, donation.receiver, _requestHash);
    }

    function getDonation(uint256 _id) public view returns (Donation memory) {
        require(_id > 0 && _id <= donationCount, "Invalid ID");
        return donations[_id];
    }
}
