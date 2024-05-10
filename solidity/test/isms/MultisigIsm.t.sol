// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import "@openzeppelin/contracts/utils/Strings.sol";

import {IMultisigIsm} from "../../contracts/interfaces/isms/IMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {StaticMerkleRootMultisigIsmFactory, StaticMessageIdMultisigIsmFactory} from "../../contracts/isms/multisig/StaticMultisigIsm.sol";
import {MerkleRootMultisigIsmMetadata} from "../../contracts/isms/libs/MerkleRootMultisigIsmMetadata.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {StaticThresholdAddressSetFactory} from "../../contracts/libs/StaticAddressSetFactory.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MerkleTreeHook} from "../../contracts/hooks/MerkleTreeHook.sol";
import {TestMerkleTreeHook} from "../../contracts/test/TestMerkleTreeHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {ThresholdTestUtils} from "./IsmTestUtils.sol";

/// @notice since we removed merkle tree from the mailbox, we need to include the MerkleTreeHook in the test
abstract contract AbstractMultisigIsmTest is Test {
    using Message for bytes;
    using TypeCasts for address;
    using Strings for uint256;
    using Strings for uint8;

    string constant fixtureKey = "fixture";
    string constant signatureKey = "signature";
    string constant signaturesKey = "signatures";

    uint32 constant ORIGIN = 11;
    StaticThresholdAddressSetFactory factory;
    IMultisigIsm ism;
    TestMerkleTreeHook internal merkleTreeHook;
    TestPostDispatchHook internal noopHook;
    TestMailbox mailbox;

    function metadataPrefix(
        bytes memory message
    ) internal virtual returns (bytes memory, string memory);

    function fixtureInit(uint8 moduleType, string memory prefix) internal {
        vm.serializeUint(fixtureKey, "type", uint256(moduleType));
        vm.serializeString(fixtureKey, "prefix", prefix);
    }

    function fixtureAppendSignature(
        uint256 index,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        vm.serializeUint(signatureKey, "v", uint256(v));
        vm.serializeBytes32(signatureKey, "r", r);
        string memory signature = vm.serializeBytes32(signatureKey, "s", s);
        vm.serializeString(signaturesKey, index.toString(), signature);
    }

    function writeFixture(bytes memory metadata, uint8 m, uint8 n) internal {
        vm.serializeString(
            fixtureKey,
            "signatures",
            vm.serializeString(signaturesKey, "dummy", "dummy")
        );

        string memory fixturePath = string(
            abi.encodePacked(
                "./fixtures/multisig/",
                m.toString(),
                "-",
                n.toString(),
                ".json"
            )
        );
        vm.writeJson(
            vm.serializeBytes(fixtureKey, "encoded", metadata),
            fixturePath
        );
    }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    ) internal returns (bytes memory) {
        bytes32 digest;
        {
            uint32 domain = mailbox.localDomain();
            (bytes32 root, uint32 index) = merkleTreeHook.latestCheckpoint();
            bytes32 messageId = message.id();
            bytes32 merkleTreeAddress = address(merkleTreeHook)
                .addressToBytes32();
            digest = CheckpointLib.digest(
                domain,
                merkleTreeAddress,
                root,
                index,
                messageId
            );
        }

        uint256[] memory signers = ThresholdTestUtils.choose(
            m,
            addValidators(m, n, seed),
            seed
        );

        (bytes memory metadata, string memory prefix) = metadataPrefix(message);
        fixtureInit(ism.moduleType(), prefix);

        for (uint256 i = 0; i < m; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i], digest);
            metadata = abi.encodePacked(metadata, r, s, v);

            fixtureAppendSignature(i, v, r, s);
        }

        writeFixture(metadata, m, n);

        return metadata;
    }

    function addValidators(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) internal returns (uint256[] memory) {
        uint256[] memory keys = new uint256[](n);
        address[] memory addresses = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 key = uint256(keccak256(abi.encode(seed, i)));
            keys[i] = key;
            addresses[i] = vm.addr(key);
        }
        ism = IMultisigIsm(factory.deploy(addresses, m));
        return keys;
    }

    function getMessage(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body
    ) internal returns (bytes memory) {
        bytes memory message = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );
        merkleTreeHook.insert(message.id());
        return message;
    }

    function testVerify(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, message);
        assertTrue(ism.verify(metadata, message));
    }

    function testFailVerify(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, message);

        // changing single byte in metadata should fail signature verification
        uint256 index = uint256(seed) % metadata.length;
        metadata[index] = ~metadata[index];
        assertFalse(ism.verify(metadata, message));
    }
}

contract MerkleRootMultisigIsmTest is AbstractMultisigIsmTest {
    using TypeCasts for address;
    using Message for bytes;
    using Strings for uint256;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();
        factory = new StaticMerkleRootMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }

    // TODO: test merkleIndex != signedIndex
    function metadataPrefix(
        bytes memory message
    ) internal override returns (bytes memory metadata, string memory prefix) {
        uint32 checkpointIndex = uint32(merkleTreeHook.count() - 1);
        bytes32[32] memory proof = merkleTreeHook.proof();
        bytes32 messageId = message.id();
        bytes32 merkleTreeAddress = address(merkleTreeHook).addressToBytes32();

        prefix = "prefix";
        vm.serializeUint(prefix, "index", uint256(checkpointIndex));
        vm.serializeUint(prefix, "signedIndex", uint256(checkpointIndex));
        vm.serializeBytes32(prefix, "merkleTree", merkleTreeAddress);
        string memory proofString = "proof";
        for (uint256 i = 0; i < 32; i++) {
            vm.serializeBytes32(proofString, i.toString(), proof[i]);
        }
        proofString = vm.serializeString(proofString, "dummy", "dummy");
        vm.serializeString(prefix, "proof", proofString);
        prefix = vm.serializeBytes32(prefix, "id", messageId);

        metadata = abi.encodePacked(
            merkleTreeAddress,
            checkpointIndex,
            messageId,
            proof,
            checkpointIndex
        );
    }
}

contract MessageIdMultisigIsmTest is AbstractMultisigIsmTest {
    using TypeCasts for address;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();

        factory = new StaticMessageIdMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }

    function metadataPrefix(
        bytes memory
    ) internal override returns (bytes memory metadata, string memory prefix) {
        (bytes32 root, uint32 index) = merkleTreeHook.latestCheckpoint();
        bytes32 merkleTreeAddress = address(merkleTreeHook).addressToBytes32();
        prefix = "prefix";
        vm.serializeBytes32(prefix, "root", root);
        vm.serializeUint(prefix, "signedIndex", uint256(index));
        prefix = vm.serializeBytes32(prefix, "merkleTree", merkleTreeAddress);
        metadata = abi.encodePacked(merkleTreeAddress, root, index);
    }
}
