// SPDX-License-Identifier: MIT
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
import {MessagingParams, MessagingFee, ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";
import {Indexed} from "../../libs/Indexed.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractMessageIdAuthHook} from "../libs/AbstractMessageIdAuthHook.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import "forge-std/console.sol";

struct LayerZeroV2Metadata {
    /// @dev the endpoint Id. prev dstChainId
    uint32 eid;
    /// @dev if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
    address refundAddress;
    /// @dev  parameters for the adapter service, e.g. send some dust native token to dstChain. prev adapterParam
    bytes options;
}

contract LayerZeroV2Hook is AbstractMessageIdAuthHook, Indexed {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

    ILayerZeroEndpointV2 immutable lZEndpoint;

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _lZEndpoint
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        lZEndpoint = ILayerZeroEndpointV2(_lZEndpoint);
    }

    // ============ External Functions ============

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes memory payload
    ) internal override {
        bytes calldata lZMetadata = metadata.getCustomMetadata();
        (
            uint32 eid,
            address payable refundAddress,
            bytes memory options
        ) = parseLzMetadata(lZMetadata);

        // Build and send message
        MessagingParams memory msgParams = MessagingParams(
            eid,
            ism,
            payload,
            options,
            false
        );
        lZEndpoint.send{value: msg.value}(msgParams, refundAddress);
    }

    /// @dev payInZRO is hardcoed to false because zro tokens should not be directly accepted
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual override returns (uint256) {
        bytes calldata lZMetadata = metadata.getCustomMetadata();
        (uint32 eid, , bytes memory options) = parseLzMetadata(lZMetadata);

        // Build and quote message
        MessagingParams memory msgParams = MessagingParams(
            eid,
            message.recipient(),
            message.body(),
            options,
            false
        );
        MessagingFee memory msgFee = lZEndpoint.quote(
            msgParams,
            message.senderAddress()
        );

        return msgFee.nativeFee;
    }

    /**
     * @notice Formats LayerZero metadata using default abi encoding
     * @param layerZeroMetadata LayerZero specific metadata
     * @return ABI encoded metadata
     */
    function formatLzMetadata(
        LayerZeroV2Metadata calldata layerZeroMetadata
    ) public pure returns (bytes memory) {
        return
            abi.encode(
                layerZeroMetadata.eid,
                layerZeroMetadata.refundAddress,
                layerZeroMetadata.options
            );
    }

    /**
     * @notice Decodes LayerZero metadata. Should be used after formatLzMetadata()
     * @param lZMetadata ABI encoded metadata
     */
    function parseLzMetadata(
        bytes calldata lZMetadata
    )
        public
        pure
        returns (
            uint32 eid,
            address payable refundAddress,
            bytes memory options
        )
    {
        (eid, refundAddress, options) = abi.decode(
            lZMetadata,
            (uint32, address, bytes)
        );
    }
}
