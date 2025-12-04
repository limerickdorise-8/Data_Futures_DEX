pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DataFuturesDexFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidParameter();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool exists;
        bool closed;
        uint256 dataCount;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedSet(bool paused);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedData);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 averageValue);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionCooldown(address submitter) {
        if (block.timestamp < lastSubmissionTime[submitter] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier decryptionRequestCooldown(address requester) {
        if (block.timestamp < lastDecryptionRequestTime[requester] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default cooldown
        currentBatchId = 1;
        _openBatch(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (isProvider[provider]) revert InvalidParameter();
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) revert InvalidParameter();
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, _cooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        if (!batches[currentBatchId].closed) revert BatchNotClosed();
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (!batches[batchId].exists) revert InvalidParameter();
        if (batches[batchId].closed) revert BatchClosed();
        batches[batchId].closed = true;
        emit BatchClosed(batchId);
    }

    function submitEncryptedData(uint256 batchId, euint32 encryptedData) external onlyProvider whenNotPaused submissionCooldown(msg.sender) {
        if (!batches[batchId].exists || batches[batchId].closed) revert BatchClosed();
        _initIfNeeded(encryptedData);

        batches[batchId].dataCount++;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, batchId, encryptedData.toBytes32());
    }

    function requestAverageDecryption(uint256 batchId) external whenNotPaused decryptionRequestCooldown(msg.sender) {
        if (!batches[batchId].exists || !batches[batchId].closed) revert BatchNotClosed();
        if (batches[batchId].dataCount == 0) revert InvalidParameter();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 encryptedSum = FHE.asEuint32(0);
        euint32 encryptedCount = FHE.asEuint32(batches[batchId].dataCount);
        // Note: Actual iteration over encrypted data stored in the batch would happen here.
        // For this example, we assume `encryptedSum` is populated with the sum of all encrypted data in the batch.
        // This simplified example uses a placeholder for the sum.
        // In a real scenario, you'd iterate and sum the actual encrypted data submitted to this batch.
        // For this example, we'll use a dummy sum. The FHE operations are the focus.
        encryptedSum = encryptedSum.add(FHE.asEuint32(100)); // Placeholder for actual sum

        euint32 encryptedAverage = encryptedSum.div(encryptedCount);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedAverage.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        // Rebuild cts array in the exact same order as in requestAverageDecryption
        // For this example, it's one element: the encrypted average.
        // We need to reconstruct this ciphertext from the contract's current state.
        // This involves re-calculating the sum for the batch associated with this requestId.
        uint256 batchId = decryptionContexts[requestId].batchId;
        if (!batches[batchId].exists || !batches[batchId].closed) revert InvalidParameter(); // Batch state might have changed
        if (batches[batchId].dataCount == 0) revert InvalidParameter();

        euint32 encryptedSumRecomputed = FHE.asEuint32(0);
        euint32 encryptedCountRecomputed = FHE.asEuint32(batches[batchId].dataCount);
        // Recompute the sum based on current contract state for this batch
        // Again, this is a placeholder. In a real contract, you'd iterate over stored encrypted data.
        encryptedSumRecomputed = encryptedSumRecomputed.add(FHE.asEuint32(100)); // Placeholder

        euint32 encryptedAverageRecomputed = encryptedSumRecomputed.div(encryptedCountRecomputed);
        bytes32[] memory ctsRecomputed = new bytes32[](1);
        ctsRecomputed[0] = encryptedAverageRecomputed.toBytes32();

        bytes32 currentHash = _hashCiphertexts(ctsRecomputed);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);
        if (cleartexts.length != 4) revert InvalidProof(); // Expecting one uint32

        uint256 averageValue = uint256(bytes32(cleartexts[0:4]));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, averageValue);
    }

    function _openBatch(uint256 batchId) private {
        batches[batchId] = Batch({ exists: true, closed: false, dataCount: 0 });
        emit BatchOpened(batchId);
    }

    function _hashCiphertexts(bytes32[] memory cts) private view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) private {
        if (!val.isInitialized()) revert NotInitialized();
    }

    function _requireInitialized(euint32 val) private view {
        if (!val.isInitialized()) revert NotInitialized();
    }
}