// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TestRouter} from "../contracts/test/TestRouter.sol";
import {TestMailbox} from "../contracts/test/TestMailbox.sol";
import {TestInterchainGasPaymaster} from "../contracts/test/TestInterchainGasPaymaster.sol";
import {TestMultisigIsm} from "../contracts/test/TestMultisigIsm.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract RouterTest is Test {
    TestRouter router;
    TestMailbox mailbox;
    TestInterchainGasPaymaster igp;
    TestMultisigIsm ism;

    uint32 localDomain = 1000;
    uint32 origin = 1;
    uint32 destination = 2;
    uint32 destinationWithoutRouter = 3;
    bytes body = "0xdeadbeef";

    event InitializeOverload();
    event Dispatch(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        bytes message
    );
    event GasPayment(
        bytes32 indexed messageId,
        uint256 gasAmount,
        uint256 payment
    );

    function setUp() public {
        mailbox = new TestMailbox(localDomain);
        igp = new TestInterchainGasPaymaster(address(this));
        router = new TestRouter();
        ism = new TestMultisigIsm();
        ism.setAccept(true);
    }

    function testInitialize() public {
        vm.expectEmit(false, false, false, false);
        emit InitializeOverload();
        router.initialize(address(mailbox), address(igp));
        assertEq(address(router.mailbox()), address(mailbox));
        assertEq(address(router.interchainGasPaymaster()), address(igp));
        assertEq(address(router.owner()), address(this));

        vm.expectRevert(
            bytes("Initializable: contract is already initialized")
        );
        router.initialize(address(mailbox), address(igp));
    }

    function testEnrolledMailboxAndRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 sender = TypeCasts.addressToBytes32(address(1));
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        router.enrollRemoteRouter(origin, sender);
        // Does not revert.
        mailbox.testHandle(origin, sender, recipient, body);
    }

    function testUnenrolledMailbox() public {
        vm.expectRevert(bytes("!mailbox"));
        router.handle(origin, TypeCasts.addressToBytes32(address(1)), body);
    }

    function testUnenrolledRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 sender = TypeCasts.addressToBytes32(address(1));
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        vm.expectRevert(
            bytes(
                "No router enrolled for domain. Did you specify the right domain ID?"
            )
        );
        mailbox.testHandle(origin, sender, recipient, body);
    }

    function testOwnerEnrollRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        assertEq(router.isRemoteRouter(origin, remote), false);
        vm.expectRevert(
            bytes(
                "No router enrolled for domain. Did you specify the right domain ID?"
            )
        );
        router.mustHaveRemoteRouter(origin);

        router.enrollRemoteRouter(origin, remote);
        assertEq(router.isRemoteRouter(1, remote), true);
        assertEq(router.mustHaveRemoteRouter(1), remote);
    }

    function testNotOwnerEnrollRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        vm.prank(address(1));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        router.enrollRemoteRouter(origin, remote);
    }

    function testOwnerBatchEnrollRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        assertEq(router.isRemoteRouter(origin, remote), false);
        vm.expectRevert(
            bytes(
                "No router enrolled for domain. Did you specify the right domain ID?"
            )
        );
        router.mustHaveRemoteRouter(origin);

        uint32[] memory domains = new uint32[](1);
        domains[0] = origin;
        bytes32[] memory addresses = new bytes32[](1);
        addresses[0] = remote;
        router.enrollRemoteRouters(domains, addresses);
        assertEq(router.isRemoteRouter(origin, remote), true);
        assertEq(router.mustHaveRemoteRouter(origin), remote);
    }

    function testReturnDomains() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        uint32[] memory domains = new uint32[](2);
        domains[0] = origin;
        domains[1] = destination;
        bytes32[] memory addresses = new bytes32[](2);
        addresses[0] = remote;
        addresses[1] = remote;
        router.enrollRemoteRouters(domains, addresses);
        assertEq(router.domains()[0], domains[0]);
        assertEq(router.domains()[1], domains[1]);
    }

    function formatMessage(
        uint8 _version,
        uint32 _nonce,
        uint32 _originDomain,
        bytes32 _sender,
        uint32 _destinationDomain,
        bytes32 _recipient,
        bytes memory _messageBody
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                _version,
                _nonce,
                _originDomain,
                _sender,
                _destinationDomain,
                _recipient,
                _messageBody
            );
    }

    function testDispatch() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        router.enrollRemoteRouter(
            destination,
            TypeCasts.addressToBytes32(address(1))
        );
        vm.expectEmit(true, true, true, true, address(mailbox));
        bytes memory message = formatMessage(
            mailbox.VERSION(),
            mailbox.count(),
            localDomain,
            TypeCasts.addressToBytes32(address(router)),
            destination,
            TypeCasts.addressToBytes32(address(1)),
            body
        );
        emit Dispatch(
            address(router),
            destination,
            TypeCasts.addressToBytes32(address(1)),
            message
        );
        router.dispatch(destination, body);

        vm.expectRevert(
            bytes(
                "No router enrolled for domain. Did you specify the right domain ID?"
            )
        );
        router.dispatch(destinationWithoutRouter, body);
    }

    function testDispatchWithGas() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        router.enrollRemoteRouter(
            destination,
            TypeCasts.addressToBytes32(address(1))
        );
        bytes memory message = formatMessage(
            mailbox.VERSION(),
            mailbox.count(),
            localDomain,
            TypeCasts.addressToBytes32(address(router)),
            destination,
            TypeCasts.addressToBytes32(address(1)),
            body
        );
        bytes32 messageId = keccak256(message);
        uint256 gasAmount = 4321;
        uint256 gasPayment = 43210;
        address gasPaymentRefundAddress = address(this);
        vm.expectEmit(true, true, true, true, address(mailbox));
        emit Dispatch(
            address(router),
            destination,
            TypeCasts.addressToBytes32(address(1)),
            message
        );

        vm.expectEmit(true, true, true, true, address(igp));
        emit GasPayment(messageId, gasAmount, gasPayment);

        router.dispatchWithGas{value: gasPayment}(
            destination,
            body,
            gasAmount,
            gasPayment,
            gasPaymentRefundAddress
        );

        vm.expectRevert(
            bytes(
                "No router enrolled for domain. Did you specify the right domain ID?"
            )
        );
        router.dispatchWithGas(
            destinationWithoutRouter,
            body,
            gasAmount,
            gasPayment,
            gasPaymentRefundAddress
        );
    }
}
