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
import {AbstractMessageIdAuthorizedIsm} from "../isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {AbstractPostDispatchHook} from "./AbstractPostDispatchHook.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {StandardHookMetadata} from "../libs/hooks/StandardHookMetadata.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

/**
 * @title AbstractMessageIdAuthHook
 * @notice Message hook to inform an Abstract Message ID ISM of messages published through
 * a third-party bridge.
 */
abstract contract AbstractMessageIdAuthHook is
    AbstractPostDispatchHook,
    MailboxClient
{
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // ============ Constants ============

    // address for ISM to verify messages
    address public immutable ism;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;

    // ============ Constructor ============

    constructor(
        address mailbox,
        uint32 _destinationDomain,
        address _ism
    ) MailboxClient(mailbox) {
        require(_ism != address(0), "AbstractMessageIdAuthHook: invalid ISM");
        require(
            _destinationDomain != 0,
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        ism = _ism;
        destinationDomain = _destinationDomain;
    }

    // ============ Internal functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
    {
        bytes32 id = message.id();
        require(
            _isLatestDispatched(id),
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        require(
            message.destination() == destinationDomain,
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            id
        );
        _sendMessageId(metadata, payload);
    }

    /**
     * @notice Send a message to the ISM.
     * @param metadata The metadata for the hook caller
     * @param payload The payload for call to the ISM
     */
    function _sendMessageId(bytes calldata metadata, bytes memory payload)
        internal
        virtual;
}
