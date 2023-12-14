// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {BridgeAggregationHookMetadata} from "../../contracts/hooks/libs/BridgeAggregationHookMetadata.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {AxelarHook} from "../../contracts/hooks/Axelar/AxelarHook.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";

contract AxelarHookTest is Test {
    using StandardHookMetadata for bytes;
    using BridgeAggregationHookMetadata for bytes;
    using TypeCasts for address;

    AxelarHook hook;
    TestMailbox mailbox;

    address internal alice = address(0x1); // alice the user
    address internal bob = address(0x2); // bob the beneficiary
    address internal charlie = address(0x3); // charlie the crock
    bytes internal testMessage;

    uint32 internal constant TEST_ORIGIN_DOMAIN = 1;
    uint32 internal constant TEST_DESTINATION_DOMAIN = 2;

    string destinationChain = "Neutron";
    string destionationContract = "neutronContract";
    address axelarGateway = address(0);
    address axelarGasReceiver = address(0);
    bytes gmp_call_code = abi.encodePacked(uint8(1));
    error BadQuote(uint256 balance, uint256 required);

    function setUp() public {
        mailbox = new TestMailbox(1);

        hook = new AxelarHook(
            address(mailbox),
            destinationChain,
            destionationContract,
            axelarGateway,
            axelarGasReceiver,
            gmp_call_code
        );
        testMessage = _encodeTestMessage();
    }

    function test_quoteDispatch_revertsWithNoMetadata() public {
        vm.expectRevert("No Axelar Payment Received");

        bytes memory emptyCustomMetadata;
        bytes memory testMetadata = StandardHookMetadata.formatMetadata(
            100,
            100,
            msg.sender,
            emptyCustomMetadata
        );

        hook.quoteDispatch(testMetadata, testMessage);
    }

    function test_quoteDispatch_revertsWithZeroQuote() public {
        vm.expectRevert("No Axelar Payment Received");
        uint256 expectedQuote = 0;
        bytes memory justRightCustomMetadata = BridgeAggregationHookMetadata
            .formatMetadata(expectedQuote, 0, abi.encodePacked());
        bytes memory testMetadata = StandardHookMetadata.formatMetadata(
            100,
            100,
            msg.sender,
            justRightCustomMetadata
        );

        hook.quoteDispatch(testMetadata, testMessage);
    }

    function test_quoteDispatch_ReturnsSmallQuote() public {
        uint256 expectedQuote = 1;
        bytes memory justRightCustomMetadata = BridgeAggregationHookMetadata
            .formatMetadata(expectedQuote, 0, abi.encodePacked());
        bytes memory testMetadata = StandardHookMetadata.formatMetadata(
            100,
            100,
            msg.sender,
            justRightCustomMetadata
        );

        uint256 quote = hook.quoteDispatch(testMetadata, testMessage);
        assertEq(quote, expectedQuote);
    }

    function test_quoteDispatch_ReturnsLargeQuote() public {
        // type(uint256).max = 115792089237316195423570985008687907853269984665640564039457584007913129639935. that's a big quote
        uint256 expectedQuote = type(uint256).max;
        bytes memory justRightCustomMetadata = BridgeAggregationHookMetadata
            .formatMetadata(expectedQuote, 0, abi.encodePacked());
        bytes memory testMetadata = StandardHookMetadata.formatMetadata(
            100,
            100,
            msg.sender,
            justRightCustomMetadata
        );

        uint256 quote = hook.quoteDispatch(testMetadata, testMessage);
        assertEq(quote, expectedQuote);
    }

    // ============ Helper Functions ============

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                uint8(0),
                uint32(1),
                TEST_ORIGIN_DOMAIN,
                alice.addressToBytes32(),
                TEST_DESTINATION_DOMAIN,
                alice.addressToBytes32(),
                abi.encodePacked("Hello World")
            );
    }

    receive() external payable {} // to use when tests expand
}
