// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {OwnableMulticall, Call, Result} from "../OwnableMulticall.sol";
import {Router} from "../Router.sol";
import {IInterchainQueryRouter} from "../../interfaces/IInterchainQueryRouter.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract InterchainQueryRouter is
    Router,
    OwnableMulticall,
    IInterchainQueryRouter
{
    enum Action {
        DISPATCH,
        RESOLVE
    }

    event QueryDispatched(
        uint32 indexed destinationDomain,
        address indexed sender
    );
    event QueryReturned(uint32 indexed originDomain, address indexed sender);
    event QueryResolved(
        uint32 indexed destinationDomain,
        address indexed sender
    );

    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule
    ) external initializer {
        // Transfer ownership of the contract to `msg.sender`
        __Router_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule
        );
    }

    function initialize(address _mailbox, address _interchainGasPaymaster)
        external
        initializer
    {
        // Transfer ownership of the contract to `msg.sender`
        __Router_initialize(_mailbox, _interchainGasPaymaster);
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param target The address of the contract to query on destination chain.
     * @param queryData The calldata of the view call to make on the destination chain.
     * @param callback Callback function selector on `msg.sender` and optionally abi-encoded prefix arguments.
     */
    function query(
        uint32 _destinationDomain,
        address target,
        bytes calldata queryData,
        bytes calldata callback
    ) external returns (bytes32 messageId) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({to: target, data: queryData});
        bytes[] memory callbacks = new bytes[](1);
        callbacks[0] = callback;
        messageId = query(_destinationDomain, calls, callbacks);
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param call Call (to and data packed struct) to be made on destination chain.
     * @param callback Callback function selector on `msg.sender` and optionally abi-encoded prefix arguments.
     */
    function query(
        uint32 _destinationDomain,
        Call calldata call,
        bytes calldata callback
    ) external returns (bytes32 messageId) {
        Call[] memory calls = new Call[](1);
        calls[0] = call;
        bytes[] memory callbacks = new bytes[](1);
        callbacks[0] = callback;
        messageId = query(_destinationDomain, calls, callbacks);
    }

    /**
     * @param _destinationDomain Domain of destination chain
     * @param calls Array of calls (to and data packed struct) to be made on destination chain in sequence.
     * @param callbacks Array of callback function selectors on `msg.sender` and optionally abi-encoded prefix arguments.
     */
    function query(
        uint32 _destinationDomain,
        Call[] memory calls,
        bytes[] memory callbacks
    ) public returns (bytes32 messageId) {
        require(
            calls.length == callbacks.length,
            "InterchainQueryRouter: calls and callbacks must be same length"
        );
        messageId = _dispatch(
            _destinationDomain,
            abi.encode(Action.DISPATCH, msg.sender, calls, callbacks)
        );
        emit QueryDispatched(_destinationDomain, msg.sender);
    }

    function _handle(
        uint32 _origin,
        bytes32, // router sender
        bytes calldata _message
    ) internal override {
        Action action = abi.decode(_message, (Action));
        if (action == Action.DISPATCH) {
            (
                ,
                address sender,
                Call[] memory calls,
                bytes[] memory callbacks
            ) = abi.decode(_message, (Action, address, Call[], bytes[]));
            Result[] memory results = _staticcall(calls, callbacks);
            _dispatch(_origin, abi.encode(Action.RESOLVE, sender, results));
            emit QueryReturned(_origin, sender);
        } else if (action == Action.RESOLVE) {
            (, address sender, Result[] memory resolveCallbacks) = abi.decode(
                _message,
                (Action, address, Result[])
            );
            resolveResults(sender, resolveCallbacks);
            emit QueryResolved(_origin, sender);
        }
    }
}
