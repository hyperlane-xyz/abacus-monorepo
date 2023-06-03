// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {OptimismISM} from "../../contracts/isms/native/OptimismISM.sol";
import {OptimismMessageHook} from "../../contracts/hooks/OptimismMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {Lib_CrossDomainUtils} from "@eth-optimism/contracts/libraries/bridge/Lib_CrossDomainUtils.sol";
import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {ICanonicalTransactionChain} from "@eth-optimism/contracts/L1/rollup/ICanonicalTransactionChain.sol";
import {L2CrossDomainMessenger} from "@eth-optimism/contracts/L2/messaging/L2CrossDomainMessenger.sol";

contract OptimismISMTest is Test {
    uint256 public mainnetFork;
    uint256 public optimismFork;

    address public constant L1_MESSENGER_ADDRESS =
        0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1;
    address public constant L1_CANNONICAL_CHAIN =
        0x5E4e65926BA27467555EB562121fac00D24E9dD2;
    address public constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;

    uint8 public constant VERSION = 0;
    uint256 public constant DEFAULT_GAS_LIMIT = 1_920_000;

    address public alice = address(0x1);

    ICrossDomainMessenger public opNativeMessenger;
    OptimismISM public opISM;
    OptimismMessageHook public opHook;

    TestRecipient public testRecipient;
    bytes public testMessage = abi.encodePacked("Hello from the other chain!");

    uint32 public constant MAINNET_DOMAIN = 1;
    uint32 public constant OPTIMISM_DOMAIN = 10;

    event OptimismMessagePublished(
        address indexed sender,
        bytes32 indexed messageId
    );

    event SentMessage(
        address indexed target,
        address sender,
        bytes message,
        uint256 messageNonce,
        uint256 gasLimit
    );

    event RelayedMessage(bytes32 indexed msgHash);

    event FailedRelayedMessage(bytes32 indexed msgHash);

    event ReceivedMessage(address indexed emitter, bytes32 indexed messageId);

    error NotCrossChainCall();

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        optimismFork = vm.createFork(vm.rpcUrl("optimism"));

        testRecipient = new TestRecipient();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployOptimismHook() public {
        vm.selectFork(mainnetFork);

        opNativeMessenger = ICrossDomainMessenger(L1_MESSENGER_ADDRESS);
        opHook = new OptimismMessageHook(
            OPTIMISM_DOMAIN,
            address(opNativeMessenger),
            address(opISM)
        );

        vm.makePersistent(address(opHook));
    }

    function deployOptimsimISM() public {
        vm.selectFork(optimismFork);

        opISM = new OptimismISM(
            address(L2CrossDomainMessenger(L2_MESSENGER_ADDRESS))
        );

        vm.makePersistent(address(opISM));
    }

    function deployAll() public {
        deployOptimsimISM();
        deployOptimismHook();

        vm.selectFork(optimismFork);
        opISM.setOptimismHook(address(opHook));
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.postDispatch ============ */

    function testDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), messageId)
        );

        uint40 nonce = ICanonicalTransactionChain(L1_CANNONICAL_CHAIN)
            .getQueueLength();

        vm.expectEmit(true, true, true, true, L1_MESSENGER_ADDRESS);
        emit SentMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nonce,
            DEFAULT_GAS_LIMIT
        );

        vm.expectEmit(true, true, true, true, address(opHook));
        emit OptimismMessagePublished(address(this), messageId);

        opHook.postDispatch(OPTIMISM_DOMAIN, messageId);
    }

    function testDispatch_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.expectRevert("OptimismHook: invalid destination domain");
        opHook.postDispatch(11, messageId);
    }

    /* ============ ISM.receiveFromHook ============ */

    function testReceiveFromHook() public {
        deployAll();

        vm.selectFork(optimismFork);
        assertEq(vm.activeFork(), optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            L2_MESSENGER_ADDRESS
        );

        bytes32 _messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), _messageId)
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        bytes memory xDomainCalldata = Lib_CrossDomainUtils
            .encodeXDomainCalldata(
                address(opISM),
                address(opHook),
                encodedHookData,
                nextNonce
            );

        vm.startPrank(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS)
        );

        vm.expectEmit(true, true, false, false, address(opISM));
        emit ReceivedMessage(address(this), _messageId);

        vm.expectEmit(true, false, false, false, L2_MESSENGER_ADDRESS);
        emit RelayedMessage(Message.id(xDomainCalldata));

        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        assertEq(opISM.receivedEmitters(_messageId, address(this)), true);

        vm.stopPrank();
    }

    function testReceiveFromHook_NotAuthorized() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        // needs to be called by the cannonical messenger on Optimism
        vm.expectRevert(NotCrossChainCall.selector);
        opISM.receiveFromHook(address(opHook), _messageId);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            L2_MESSENGER_ADDRESS
        );

        // set the xDomainMessageSender storage slot as alice
        bytes32 key = bytes32(uint256(4));
        bytes32 value = TypeCasts.addressToBytes32(alice);
        vm.store(address(l2Bridge), key, value);

        vm.startPrank(L2_MESSENGER_ADDRESS);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert("OptimismISM: caller is not the owner");
        opISM.receiveFromHook(address(opHook), _messageId);
    }

    /* ============ ISM.verify ============ */

    function testVerify() public {
        deployAll();

        vm.selectFork(optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            L2_MESSENGER_ADDRESS
        );

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), _messageId)
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
    }

    function testVerify_InvalidMessage_Hyperlane() public {
        deployAll();

        vm.selectFork(optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            L2_MESSENGER_ADDRESS
        );

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), _messageId)
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = opISM.verify(new bytes(0), invalidMessage);
        assertFalse(verified);
    }

    function testVerify_InvalidMessageID_Optimism() public {
        deployAll();

        vm.selectFork(optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            L2_MESSENGER_ADDRESS
        );

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bytes32 _messageId = Message.id(invalidMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), _messageId)
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);
    }

    function testVerify_InvalidSender() public {
        deployAll();

        vm.selectFork(optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            L2_MESSENGER_ADDRESS
        );

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (alice, _messageId)
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage(uint32 _msgCount, address _receipient)
        internal
        view
        returns (bytes memory encodedMessage)
    {
        encodedMessage = abi.encodePacked(
            VERSION,
            _msgCount,
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(_receipient),
            testMessage
        );
    }
}
