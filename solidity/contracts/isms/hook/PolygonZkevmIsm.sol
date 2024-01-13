// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {IPolygonZkEVMBridge} from "../../interfaces/polygonzkevm/IPolygonZkEVMBridge.sol";
import {AbstractMessageIdAuthorizedIsm} from "../hook/AbstractMessageIdAuthorizedIsm.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {LibBit} from "../../libs/LibBit.sol";
import {IBridgeMessageReceiver} from "../../interfaces/polygonzkevm/IBridgeMessageReceiver.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title PolygonZkevmIsm
 * @notice Polygon zkEVM chain Ism that uses the Polygon zkEVM bridge to verify messages
 */
contract PolygonZkevmIsm is
    ICcipReadIsm,
    AbstractMessageIdAuthorizedIsm,
    IBridgeMessageReceiver
{
    using Message for bytes;
    using LibBit for uint256;

    IMailbox public mailbox;
    string[] public offchainUrls;

    // ============ Constants ============
    IPolygonZkEVMBridge public immutable zkEvmBridge;
    uint8 public constant override moduleType =
        uint8(IInterchainSecurityModule.Types.CCIP_READ);

    // ============ Constructor ============
    constructor(
        address _zkEvmBridge,
        IMailbox _mailbox,
        string[] memory _offchainUrls
    ) {
        require(
            Address.isContract(_zkEvmBridge),
            "PolygonZkevmIsm: invalid L2Messenger"
        );
        zkEvmBridge = IPolygonZkEVMBridge(_zkEvmBridge);
        mailbox = _mailbox;
        offchainUrls = _offchainUrls;
    }

    /// @inheritdoc AbstractMessageIdAuthorizedIsm
    function _isAuthorized() internal view override returns (bool) {
        return msg.sender == address(zkEvmBridge);
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        bytes memory messageId = abi.encodePacked(_message.id());

        revert OffchainLookup(
            address(this),
            offchainUrls,
            messageId,
            PolygonZkevmIsm.verify.selector,
            _message
        );
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata
    )
        external
        override(
            // bytes calldata _message
            AbstractMessageIdAuthorizedIsm,
            IInterchainSecurityModule
        )
        returns (bool)
    {
        (
            bytes32[32] memory smtProof,
            uint32 index,
            bytes32 mainnetExitRoot,
            bytes32 rollupExitRoot,
            uint32 originNetwork,
            address originAddress,
            uint32 destinationNetwork,
            address destinationAddress,
            uint256 amount,
            bytes memory payload
        ) = abi.decode(
                _metadata,
                (
                    bytes32[32],
                    uint32,
                    bytes32,
                    bytes32,
                    uint32,
                    address,
                    uint32,
                    address,
                    uint256,
                    bytes
                )
            );

        // bytes32 messageId = _message.id();
        zkEvmBridge.claimMessage(
            smtProof,
            index,
            mainnetExitRoot,
            rollupExitRoot,
            originNetwork,
            originAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            payload
        );
        // verifiedMessages[messageId] = verifiedMessages[messageId].setBit(
        //     VERIFIED_MASK_INDEX
        // );
        return true;
    }

    /// @inheritdoc IBridgeMessageReceiver
    function onMessageReceived(
        address,
        uint32 originNetwork,
        bytes memory data
    ) external payable override {
        require(
            originNetwork == 0,
            "PolygonZkevmIsm: origin network must be 0"
        );
        require(data.length == 32, "PolygonZkevmIsm: data must be 32 bytes");
        bytes32 messageId = abi.decode(data, (bytes32));
        require(
            !verifiedMessages[messageId].isBitSet(VERIFIED_MASK_INDEX),
            "PolygonZkevmIsm: message already verified"
        );
        verifiedMessages[messageId] = verifiedMessages[messageId].setBit(
            VERIFIED_MASK_INDEX
        );
    }
}
