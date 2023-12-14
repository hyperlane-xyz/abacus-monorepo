// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 *
 * [0:2] variant
 * [2:34] Axelar Payment
 * [34:66] Wormhole Payment
 * [66:] additional metadata
 */
library BridgeAggregationHookMetadata {
    struct Metadata {
        uint256 AxelarPayment;
        uint256 WormholePayment;
    }

    uint8 private constant AXELAR_PAYMENT_OFFSET = 0;
    uint8 private constant WORMHOLE_PAYMENT_OFFSET = 32;
    uint8 private constant MIN_METADATA_LENGTH = 64;

    /**
     * @notice Returns the required payment for Axelar bridging.
     * @param _metadata ABI encoded standard hook metadata.
     * @return uint256 Payment amount.
     */
    function axelarGasPayment(
        bytes calldata _metadata
    ) internal pure returns (uint256) {
        if (_metadata.length < AXELAR_PAYMENT_OFFSET + 32) return 0;
        return
            uint256(
                bytes32(
                    _metadata[AXELAR_PAYMENT_OFFSET:AXELAR_PAYMENT_OFFSET + 32]
                )
            );
    }

    /**
     * @notice Returns the required payment for Wormhole bridging.
     * @param _metadata ABI encoded standard hook metadata.
     * @return uint256 Payment amount.
     */
    function wormholeGasPayment(
        bytes calldata _metadata
    ) internal pure returns (uint256) {
        if (_metadata.length < WORMHOLE_PAYMENT_OFFSET + 32) return 0;
        return
            uint256(
                bytes32(
                    _metadata[WORMHOLE_PAYMENT_OFFSET:WORMHOLE_PAYMENT_OFFSET +
                        32]
                )
            );
    }

    /**
     * @notice Returs any additional metadata.
     * @param _metadata ABI encoded standard hook metadata.
     * @return bytes Additional metadata.
     */
    function getBridgeAggregationCustomMetadata(
        bytes calldata _metadata
    ) internal pure returns (bytes calldata) {
        if (_metadata.length < MIN_METADATA_LENGTH) return _metadata[0:0];
        return _metadata[MIN_METADATA_LENGTH:];
    }

    /**
     * @notice Formats the specified Axelar and Wormhole payments.
     * @param _axelarPayment msg.value for the message.
     * @param _wormholePayment Gas limit for the message.
     * @param _customMetadata Additional metadata to include.
     * @return ABI encoded standard hook metadata.
     */
    function formatMetadata(
        uint256 _axelarPayment,
        uint256 _wormholePayment,
        bytes memory _customMetadata
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(_axelarPayment, _wormholePayment, _customMetadata);
    }
}
