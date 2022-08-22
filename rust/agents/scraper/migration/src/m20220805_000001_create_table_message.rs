use crate::l20220805_000001_types::*;
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Message::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Message::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Message::TimeCreated).timestamp().not_null())
                    .col(ColumnDef::new(Message::Origin).unsigned().not_null())
                    .col(ColumnDef::new(Message::Destination).unsigned().not_null())
                    .col(ColumnDef::new(Message::LeafIndex).unsigned().not_null())
                    .col(ColumnDef::new_with_type(Message::Sender, Address).not_null())
                    .col(ColumnDef::new_with_type(Message::Recipient, Address).not_null())
                    .col(ColumnDef::new(Message::MsgBody).binary())
                    .col(ColumnDef::new_with_type(Message::OutboxAddress, Address).not_null())
                    .col(
                        ColumnDef::new(Message::DispatchTxId)
                            .big_integer()
                            .not_null(),
                    )
                    .index(
                        Index::create()
                            .unique()
                            .name("idx-outbox-origin-leaf")
                            .col(Message::OutboxAddress)
                            .col(Message::Origin)
                            .col(Message::LeafIndex),
                    )
                    .index(Index::create().name("idx-tx").col(Message::DispatchTxId))
                    .index(Index::create().name("idx-sender").col(Message::Sender))
                    .index(
                        Index::create()
                            .name("idx-recipient")
                            .col(Message::Recipient),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Message::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
enum Message {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Domain ID of the origin chain
    Origin,
    /// Domain ID of the destination chain
    Destination,
    /// Leaf index of this message in the merkle tree of the outbox
    LeafIndex,
    /// Address of the message sender on the origin chain (not necessarily the
    /// transaction signer)
    Sender,
    /// Address of the message recipient on the destination chain.
    Recipient,
    /// Binary blob included in the message.
    MsgBody,
    /// Address of the outbox contract
    OutboxAddress,
    /// Transaction this message was sent in.
    DispatchTxId,
}
