// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestIsm} from "../../contracts/test/TestIsm.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";

import {PolygonZkevmHook} from "../../contracts/hooks/PolygonZkevmHook.sol";
import {PolygonZkevmIsm} from "../../contracts/isms/hook/PolygonZkevmIsm.sol";

import "forge-std/console.sol";

contract PolygonZkEVMBridge {
    function bridgeMessage(
        uint32,
        address,
        bool,
        bytes calldata
    ) external payable {}
}

contract PolygonZkevmIsmtest is Test {
    using TypeCasts for bytes32;
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // Contracts
    TestPostDispatchHook public requiredHook;
    TestMailbox public mailbox;
    PolygonZkevmIsm public ism;

    TestRecipient internal testRecipient;

    PolygonZkEVMBridge internal polygonZkevmBridge;

    address internal hook;

    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal testMetadata =
        StandardHookMetadata.overrideRefundAddress(address(this));

    function setUp() public {
        // Setup Hyperlane
        requiredHook = new TestPostDispatchHook();
        mailbox = new TestMailbox(0);
        polygonZkevmBridge = new PolygonZkEVMBridge();
        ism = new PolygonZkevmIsm(
            address(polygonZkevmBridge),
            address(mailbox),
            new string[](0)
        );
        hook = address(0x1);
        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
        testRecipient = new TestRecipient();
    }

    function test_moduleType() public {
        assertEq(
            ism.moduleType(),
            uint8(IInterchainSecurityModule.Types.CCIP_READ)
        );
    }

    function test_verify() public {
        bytes memory message = testMessage;
        bytes memory metadata = testMetadata;

        // verify message
        bool verified = ism.verify(metadata, message);

        // check that message is verified
        assertEq(verified, true);
    }
}
