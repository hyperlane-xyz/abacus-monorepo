use crate::CheckpointSyncer;
use async_trait::async_trait;
use derive_new::new;
use eyre::{bail, Result};
use hyperlane_core::{SignedAnnouncement, SignedCheckpointWithMessageId};
use std::fmt;
use ya_gcp::{
    storage::StorageClient, AuthFlow, ClientBuilder, ClientBuilderConfig, ServiceAccountAuth,
};

const LATEST_INDEX_KEY: &str = "gcsLatestIndexKey";
const ANNOUNCEMENT_KEY: &str = "gcsAnnouncementKey";

/// Google Cloud Storage client builder
/// Provide `(None, None)` for no-auth access to public bucket[s]
/// # Example 1 - anonymous client with access to public bucket[s]
/// ```
///    use hyperlane_base::GcsStorageClientBuilder;
/// #  #[tokio::main]
/// #  async fn main() {
///    let client = GcsStorageClientBuilder::new(None, None)
///        .build("HyperlaneBucket")
///        .await.expect("failed to instantiate anonymous client");
/// #  }
///```
///
/// For authenticated write access to bucket[s] proper file path must be provided.
/// # WARN: panic-s if file path is incorrect or data in it as faulty
///
/// # Example 2 - service account key
/// ```should_panic
///    use hyperlane_base::GcsStorageClientBuilder;
/// #  #[tokio::main]
/// #  async fn main() {
///    let client = GcsStorageClientBuilder::new(Some("path/to/sac.json".into()), None)
///        .build("HyperlaneBucket")
///        .await.expect("failed to instantiate anonymous client");
/// #  }
///```
/// # Example 3 - user secret access
/// ```should_panic
///    use hyperlane_base::GcsStorageClientBuilder;
/// #  #[tokio::main]
/// #  async fn main() {
///    let client = GcsStorageClientBuilder::new(None, Some("path/to/user_secret.json".into()))
///        .build("HyperlaneBucket")
///        .await.expect("failed to instantiate anonymous client");
/// #  }
///```
#[derive(Debug, new)]
pub struct GcsStorageClientBuilder {
    /// A path to the oauth service account key json file.
    ///
    /// If this is not provided, `user_secrets` must be.
    service_account_key: Option<std::path::PathBuf>,

    /// Path to oauth user secrets, like those created by
    /// `gcloud auth application-default login`
    ///
    /// If this is not provided, `service_account_key` must be.
    user_secrets: Option<std::path::PathBuf>,
}

/// Google Cloud Storage client
/// Enables use of any of service account key OR user secrets to authenticate
/// For anonymous access to public data provide `(None, None)` to Builder
pub struct GcsStorageClient {
    // GCS storage client
    // # Read methods:
    //
    // * `get_object(&self,
    //        bucket_name: impl AsRef<str>,
    //        object_name: impl AsRef<str>
    //    ) -> Result<Bytes, ObjectError>`
    //
    // * `get_metadata(
    //        &self,
    //        bucket_name: impl AsRef<str>,
    //        object_name: impl AsRef<str>
    //   ) -> Result<Metadata, ObjectError>`
    //
    // # Write methods:
    //
    // * `insert_object(
    //        &self,
    //        bucket_name: impl AsRef<str>,
    //        object_name: impl AsRef<str>,
    //        data: impl Into<Bytes>
    //    ) -> Result<Metadata, ObjectError>`
    //
    // * `insert_with_metadata(
    //        &self,
    //        bucket_name: impl AsRef<str>,
    //        metadata: &Metadata,
    //        data: impl Into<Bytes>
    //    ) -> Result<Metadata, ObjectError>`
    //
    // # Details: https://docs.rs/ya-gcp/latest/ya_gcp/storage/struct.StorageClient.html
    inner: StorageClient,
    // bucket name of this client's storage
    bucket: String,
}

impl GcsStorageClientBuilder {
    /// Instantiates `ya_gcp:StorageClient` based on provided auth method
    /// # Param
    /// * `baucket_name` - String name of target bucket to work with, will be used by all store and get ops
    pub async fn build(self, bucket_name: impl Into<String>) -> Result<GcsStorageClient> {
        let auth = if let Some(path) = self.service_account_key {
            AuthFlow::ServiceAccount(ServiceAccountAuth::Path(path))
        } else if let Some(path) = self.user_secrets {
            AuthFlow::UserAccount(path)
        } else {
            // Public data access only - no `insert`
            AuthFlow::NoAuth
        };

        let inner = ClientBuilder::new(ClientBuilderConfig::new().auth_flow(auth))
            .await?
            .build_storage_client();
        let bucket = bucket_name.into();

        Ok(GcsStorageClient { inner, bucket })
    }
}

impl GcsStorageClient {
    // convinience formatter
    fn get_checkpoint_key(index: u32) -> String {
        format!("checkpoint_{index}_with_id.json")
    }
    // #test only method[s]
    #[cfg(test)]
    pub(crate) async fn get_by_bath(&self, path: impl AsRef<str>) -> Result<()> {
        self.inner.get_object(&self.bucket, path).await?;
        Ok(())
    }
}

// required by `CheckpointSyncer`
impl fmt::Debug for GcsStorageClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Storage")
            .field("bucket", &self.bucket)
            .finish()
    }
}

#[async_trait]
impl CheckpointSyncer for GcsStorageClient {
    /// Read the highest index of this Syncer
    async fn latest_index(&self) -> Result<Option<u32>> {
        match self.inner.get_object(&self.bucket, LATEST_INDEX_KEY).await {
            Ok(data) => Ok(Some(serde_json::from_slice(data.as_ref())?)),
            Err(e) => match e {
                // never written before to this bucket
                ya_gcp::storage::ObjectError::InvalidName(_) => Ok(None),
                _ => bail!(e),
            },
        }
    }

    /// Writes the highest index of this Syncer
    async fn write_latest_index(&self, index: u32) -> Result<()> {
        let d = serde_json::to_vec(&index)?;
        self.inner
            .insert_object(&self.bucket, LATEST_INDEX_KEY, d)
            .await?;
        Ok(())
    }

    /// Update the latest index of this syncer if necessary
    async fn update_latest_index(&self, index: u32) -> Result<()> {
        let curr = self.latest_index().await?.unwrap_or(0);
        if index > curr {
            self.write_latest_index(index).await?;
        }
        Ok(())
    }

    /// Attempt to fetch the signed (checkpoint, messageId) tuple at this index
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        let res = self
            .inner
            .get_object(&self.bucket, GcsStorageClient::get_checkpoint_key(index))
            .await?;
        let scwmi = serde_json::from_slice(res.as_ref())?;
        Ok(Some(scwmi))
    }

    /// Write the signed (checkpoint, messageId) tuple to this syncer
    async fn write_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        self.inner
            .insert_object(
                &self.bucket,
                GcsStorageClient::get_checkpoint_key(signed_checkpoint.value.index),
                serde_json::to_vec(signed_checkpoint)?,
            )
            .await?;
        Ok(())
    }

    /// Write the signed announcement to this syncer
    async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()> {
        self.inner
            .insert_object(
                &self.bucket,
                ANNOUNCEMENT_KEY,
                serde_json::to_string(signed_announcement)?,
            )
            .await?;
        Ok(())
    }

    /// Return the announcement storage location for this syncer
    fn announcement_location(&self) -> String {
        format!("gs://{}/{}", &self.bucket, ANNOUNCEMENT_KEY)
    }
}

#[tokio::test]
async fn public_landset_no_auth_works_test() {
    const LANDSET_BUCKET: &str = "gcp-public-data-landsat";
    const LANDSET_KEY: &str = "LC08/01/001/003/LC08_L1GT_001003_20140812_20170420_01_T2/LC08_L1GT_001003_20140812_20170420_01_T2_B3.TIF";
    let client = GcsStorageClientBuilder::new(None, None)
        .build(LANDSET_BUCKET)
        .await
        .unwrap();
    assert!(client.get_by_bath(LANDSET_KEY).await.is_ok());
}
