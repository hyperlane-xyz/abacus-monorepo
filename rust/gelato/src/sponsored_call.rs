use crate::types::Chain;
use crate::{types::serialize_as_decimal_str, RELAY_URL};
use ethers::types::{Address, Bytes, U256};
use serde::{Deserialize, Serialize};
use tracing::instrument;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SponsoredCallArgs {
    pub chain_id: Chain,
    pub target: Address,
    pub data: Bytes,

    // U256 by default serializes as a 0x-prefixed hexadecimal string.
    // Gelato's API expects the gasLimit to be a decimal string.
    #[serde(serialize_with = "serialize_as_decimal_str")]
    pub gas_limit: Option<U256>,
    pub retries: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct SponsoredCallCall<'a> {
    pub http: reqwest::Client,
    pub args: &'a SponsoredCallArgs,
    pub sponsor_api_key: &'a str,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SponsoredCallCallResult {
    pub task_id: String,
}

impl<'a> SponsoredCallCall<'a> {
    #[instrument]
    pub async fn run(self) -> Result<SponsoredCallCallResult, reqwest::Error> {
        let url = format!("{}/relays/v2/sponsored-call", RELAY_URL);
        let http_args = HTTPArgs {
            args: self.args,
            sponsor_api_key: self.sponsor_api_key,
        };
        let res = self.http.post(url).json(&http_args).send().await?;
        let result: HTTPResult = res.json().await?;
        Ok(SponsoredCallCallResult::from(result))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HTTPArgs<'a> {
    #[serde(flatten)]
    args: &'a SponsoredCallArgs,
    sponsor_api_key: &'a str,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct HTTPResult {
    pub task_id: String,
}

impl From<HTTPResult> for SponsoredCallCallResult {
    fn from(http: HTTPResult) -> SponsoredCallCallResult {
        SponsoredCallCallResult {
            task_id: http.task_id,
        }
    }
}

// TODO(webbhorn): Include tests near boundary of large int overflows, e.g. is nonce representation
// as u128 for serialization purposes correct given ethers::types::U256 representation in OpArgs?
#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    #[test]
    fn test_http_args_serialization() {
        let sponsor_api_key = "foobar";

        let mut args = SponsoredCallArgs {
            chain_id: Chain::Alfajores,
            target: Address::from_str("dead00000000000000000000000000000000beef").unwrap(),
            data: Bytes::from_str("aabbccdd").unwrap(),
            gas_limit: None,
            retries: None,
        };

        // When gas_limit and retries are None, ensure `null` is used
        assert_eq!(
            serde_json::to_string(&HTTPArgs {
                args: &args,
                sponsor_api_key,
            })
            .unwrap(),
            concat!(
                "{",
                r#""chainId":44787,"#,
                r#""target":"0xdead00000000000000000000000000000000beef","#,
                r#""data":"0xaabbccdd","#,
                r#""gasLimit":null,"#,
                r#""retries":null,"#,
                r#""sponsorApiKey":"foobar""#,
                r#"}"#
            ),
        );

        // When the gas limit is specified, ensure it's serialized as a decimal *string*
        args.gas_limit = Some(U256::from_dec_str("420000").unwrap());
        args.retries = Some(5);
        assert_eq!(
            serde_json::to_string(&HTTPArgs {
                args: &args,
                sponsor_api_key,
            })
            .unwrap(),
            concat!(
                "{",
                r#""chainId":44787,"#,
                r#""target":"0xdead00000000000000000000000000000000beef","#,
                r#""data":"0xaabbccdd","#,
                r#""gasLimit":"420000","#,
                r#""retries":5,"#,
                r#""sponsorApiKey":"foobar""#,
                r#"}"#
            ),
        );
    }

    #[test]
    fn test_http_result_deserialization() {
        let reply_json =
            r#"{"taskId": "0x053d975549b9298bb7672b20d3f7c0960df00d065e6f68c29abd8550b31cdbc2"}"#;
        let parsed: HTTPResult = serde_json::from_str(&reply_json).unwrap();
        assert_eq!(
            parsed,
            HTTPResult {
                task_id: String::from(
                    "0x053d975549b9298bb7672b20d3f7c0960df00d065e6f68c29abd8550b31cdbc2"
                ),
            }
        );
    }
}
