use std::collections::HashSet;
use std::future::Future;
use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use lazy_static::lazy_static;
use solana_sdk::pubkey::Pubkey;
use tracing::debug;

use hyperlane_core::{
    utils::hex_or_base58_to_h256, ChainResult, Decode, HyperlaneMessage, H256, U256,
};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
use hyperlane_warp_route::TokenMessage;

use crate::SealevelProvider;

const WARP_ROUTE_PREFIX: &str = "SOL/";
// Native SOL warp routers
lazy_static! {
    static ref NATIVE_WARP_ROUTES: HashSet<H256> = {
        HashSet::from([
            hex_or_base58_to_h256("8DtAGQpcMuD5sG3KdxDy49ydqXUggR1LQtebh2TECbAc").unwrap(),
            hex_or_base58_to_h256("BXKDfnNkgUNVT5uCfk36sv2GDtK6RwAt9SLbGiKzZkih").unwrap(),
            hex_or_base58_to_h256("7KD647mgysBeEt6PSrv2XYktkSNLzear124oaMENp8SY").unwrap(),
            hex_or_base58_to_h256("GPFwRQ5Cw6dTWnmappUKJt76DD8yawxPx28QugfCaGaA").unwrap(),
        ])
    };
}

/// Application operation verifier for Sealevel
#[derive(new)]
pub struct SealevelApplicationOperationVerifier {
    provider: SealevelProvider,
}

#[async_trait]
impl ApplicationOperationVerifier for SealevelApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        debug!(
            ?app_context,
            ?message,
            "Sealevel application operation verifier",
        );

        // Separate dependency on self and network invocations for ease of unit testing
        let check_account_does_not_exist_and_get_minimum = |account: H256| async move {
            let Ok(false) = self.account_exists(account).await else {
                return None;
            };

            self.minimum().await
        };

        Self::verify_message(
            app_context,
            message,
            check_account_does_not_exist_and_get_minimum,
        )
        .await
    }
}

impl SealevelApplicationOperationVerifier {
    async fn verify_message<F, Fut>(
        app_context: &Option<String>,
        message: &HyperlaneMessage,
        check_account_exists_and_get_minimum: F,
    ) -> Option<ApplicationOperationVerifierReport>
    where
        F: FnOnce(H256) -> Fut,
        Fut: Future<Output = Option<U256>>,
    {
        use ApplicationOperationVerifierReport::{AmountBelowMinimum, MalformedMessage};

        Self::verify_context(app_context)?;

        // Starting from this point we assume that we are in a warp route context

        NATIVE_WARP_ROUTES.get(&message.recipient)?;

        let mut reader = Cursor::new(message.body.as_slice());
        let token_message = match TokenMessage::read_from(&mut reader) {
            Ok(m) => m,
            Err(_) => return Some(MalformedMessage(message.clone())),
        };

        let minimum = check_account_exists_and_get_minimum(token_message.recipient()).await?;

        if token_message.amount() < minimum {
            return Some(AmountBelowMinimum(minimum, token_message.amount()));
        }

        None
    }

    fn verify_context(app_context: &Option<String>) -> Option<()> {
        let context = match app_context {
            Some(c) => c,
            None => return None,
        };

        if !context.starts_with(WARP_ROUTE_PREFIX) {
            return None;
        }

        Some(())
    }

    async fn minimum(&self) -> Option<U256> {
        self.provider
            .rpc()
            // We assume that account will contain no data
            .get_minimum_balance_for_rent_exemption(0)
            .await
            .ok()
            .map(|v| v.into())
    }

    async fn account_exists(&self, address: H256) -> ChainResult<bool> {
        let pubkey = Pubkey::from(<[u8; 32]>::from(address));

        match self
            .provider
            .rpc()
            .get_account_option_with_finalized_commitment(&pubkey)
            .await
        {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests;
