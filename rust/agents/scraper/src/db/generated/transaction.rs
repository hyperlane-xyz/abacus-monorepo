//! `SeaORM` Entity. Generated by sea-orm-codegen 0.10.4

use sea_orm::entity::prelude::*;

#[derive(Copy, Clone, Default, Debug, DeriveEntity)]
pub struct Entity;

impl EntityName for Entity {
    fn table_name(&self) -> &str {
        "transaction"
    }
}

#[derive(Clone, Debug, PartialEq, DeriveModel, DeriveActiveModel)]
pub struct Model {
    pub id: i64,
    pub time_created: TimeDateTime,
    pub hash: String,
    pub block_id: i64,
    pub gas_limit: f64,
    pub max_priority_fee_per_gas: Option<f64>,
    pub max_fee_per_gas: Option<f64>,
    pub gas_price: Option<f64>,
    pub effective_gas_price: Option<f64>,
    pub nonce: i64,
    pub sender: String,
    pub recipient: Option<String>,
    pub gas_used: f64,
    pub cumulative_gas_used: f64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
pub enum Column {
    Id,
    TimeCreated,
    Hash,
    BlockId,
    GasLimit,
    MaxPriorityFeePerGas,
    MaxFeePerGas,
    GasPrice,
    EffectiveGasPrice,
    Nonce,
    Sender,
    Recipient,
    GasUsed,
    CumulativeGasUsed,
}

#[derive(Copy, Clone, Debug, EnumIter, DerivePrimaryKey)]
pub enum PrimaryKey {
    Id,
}

impl PrimaryKeyTrait for PrimaryKey {
    type ValueType = i64;
    fn auto_increment() -> bool {
        true
    }
}

#[derive(Copy, Clone, Debug, EnumIter)]
pub enum Relation {
    Block,
    DeliveredMessage,
    GasPayment,
    Message,
}

impl ColumnTrait for Column {
    type EntityName = Entity;
    fn def(&self) -> ColumnDef {
        match self {
            Self::Id => ColumnType::BigInteger.def(),
            Self::TimeCreated => ColumnType::DateTime.def(),
            Self::Hash => ColumnType::String(Some(64u32)).def().unique(),
            Self::BlockId => ColumnType::BigInteger.def(),
            Self::GasLimit => ColumnType::Double.def(),
            Self::MaxPriorityFeePerGas => ColumnType::Double.def().null(),
            Self::MaxFeePerGas => ColumnType::Double.def().null(),
            Self::GasPrice => ColumnType::Double.def().null(),
            Self::EffectiveGasPrice => ColumnType::Double.def().null(),
            Self::Nonce => ColumnType::BigInteger.def(),
            Self::Sender => ColumnType::String(Some(64u32)).def(),
            Self::Recipient => ColumnType::String(Some(64u32)).def().null(),
            Self::GasUsed => ColumnType::Double.def(),
            Self::CumulativeGasUsed => ColumnType::Double.def(),
        }
    }
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::Block => Entity::belongs_to(super::block::Entity)
                .from(Column::BlockId)
                .to(super::block::Column::Id)
                .into(),
            Self::DeliveredMessage => Entity::has_many(super::delivered_message::Entity).into(),
            Self::GasPayment => Entity::has_many(super::gas_payment::Entity).into(),
            Self::Message => Entity::has_many(super::message::Entity).into(),
        }
    }
}

impl Related<super::block::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Block.def()
    }
}

impl Related<super::delivered_message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::DeliveredMessage.def()
    }
}

impl Related<super::gas_payment::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::GasPayment.def()
    }
}

impl Related<super::message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Message.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
