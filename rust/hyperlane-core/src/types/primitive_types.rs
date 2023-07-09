// Based on https://github.com/paritytech/parity-common/blob/a5ef7308d6986e62431e35d3156fed0a7a585d39/primitive-types/src/lib.rs

use primitive_types;
use std::fmt::Formatter;

use borsh::{BorshDeserialize, BorshSerialize};
use fixed_hash::{construct_fixed_hash, impl_fixed_hash_conversions};
use serde::de::Visitor;
use serde::ser::SerializeTupleStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uint::construct_uint;

/// Error type for conversion.
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// Overflow encountered.
    Overflow,
}

construct_uint! {
    /// 128-bit unsigned integer.
    #[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
    pub struct U128(2);
}
construct_uint! {
    /// 256-bit unsigned integer.
    #[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
    pub struct U256(4);
}

// impl From<primitive_types::U128> for U256 {
//     fn from(value: primitive_types::U128) -> Self {
//         let u128: U128 = U128(value.0);
//         u128.into()
//     }
// }

construct_uint! {
    /// 512-bit unsigned integer.
    #[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
    pub struct U512(8);
}

construct_fixed_hash! {
    /// 128-bit hash type.
    #[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
    pub struct H128(16);
}

construct_fixed_hash! {
    /// 160-bit hash type.
    #[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
    pub struct H160(20);
}

construct_fixed_hash! {
    /// 256-bit hash type.
    #[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
    pub struct H256(32);
}

// impl From<primitive_types::H160> for H256 {
//     fn from(value: primitive_types::H160) -> Self {
//         let u128: H160 = H160(value.0);
//         u128.into()
//     }
// }

construct_fixed_hash! {
    /// 512-bit hash type.
    #[derive(BorshSerialize, BorshDeserialize)]
    pub struct H512(64);
}

impl Serialize for H512 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_tuple_struct("H512", 1)?;
        s.serialize_field(&self.0.as_slice())?;
        s.end()
    }
}

struct H512Visitor;
impl<'de> Visitor<'de> for H512Visitor {
    type Value = H512;

    fn expecting(&self, formatter: &mut Formatter) -> std::fmt::Result {
        formatter.write_str("a 512-bit hash")
    }

    fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        v.try_into()
            .map_err(|_| E::invalid_length(v.len(), &self))
            .map(H512)
    }
}

impl<'de> Deserialize<'de> for H512 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_tuple_struct("H512", 1, H512Visitor)
    }
}

type PrimitiveH160 = primitive_types::H160;
impl_fixed_hash_conversions!(H256, PrimitiveH160);
impl_fixed_hash_conversions!(H256, H160);
impl_fixed_hash_conversions!(H512, H256);
impl_fixed_hash_conversions!(H512, H160);

macro_rules! impl_fixed_uint_conversions {
    ($larger:ty, $smaller:ty) => {
        impl From<$smaller> for $larger {
            impl_fixed_uint_conversions!(@from_smaller $larger, $smaller);
        }

        impl<'a> From<&'a $smaller> for $larger {
            impl_fixed_uint_conversions!(@from_smaller $larger, &'a $smaller);
        }

        impl TryFrom<$larger> for $smaller {
            type Error = Error;
            impl_fixed_uint_conversions!(@try_from_larger $larger, $smaller);
        }

        impl<'a> TryFrom<&'a $larger> for $smaller {
            type Error = Error;
            impl_fixed_uint_conversions!(@try_from_larger &'a $larger, $smaller);
        }
    };
    (@from_smaller $larger:ty, $smaller:ty) => {
        fn from(val: $smaller) -> $larger {
            let mut ret = <$larger>::zero();
            for i in 0..val.0.len() {
                ret.0[i] = val.0[i];
            }
            ret
        }
    };
    (@try_from_larger $larger:ty, $smaller:ty) => {
        fn try_from(val: $larger) -> Result<$smaller, Error> {
            let mut ret = <$smaller>::zero();
            for i in 0..ret.0.len() {
                ret.0[i] = val.0[i];
            }

            let mut ov = 0;
            for i in ret.0.len()..val.0.len() {
                ov |= val.0[i];
            }
            if ov == 0 {
                Ok(ret)
            } else {
                Err(Error::Overflow)
            }
        }
    };
}

impl_fixed_uint_conversions!(U256, primitive_types::U128);
impl_fixed_uint_conversions!(U256, U128);
impl_fixed_uint_conversions!(U512, U128);
impl_fixed_uint_conversions!(U512, U256);

macro_rules! impl_f64_conversions {
    ($ty:ty) => {
        impl $ty {
            /// Lossy saturating conversion from a `f64` to a `$ty`. Like for floating point to
            /// primitive integer type conversions, this truncates fractional parts.
            ///
            /// The conversion follows the same rules as converting `f64` to other
            /// primitive integer types. Namely, the conversion of `value: f64` behaves as
            /// follows:
            /// - `NaN` => `0`
            /// - `(-∞, 0]` => `0`
            /// - `(0, $ty::MAX]` => `value as $ty`
            /// - `($ty::MAX, +∞)` => `$ty::MAX`
            pub fn from_f64_lossy(val: f64) -> $ty {
                const TY_BITS: u64 = <$ty>::zero().0.len() as u64 * <$ty>::WORD_BITS as u64;
                if val >= 1.0 {
                    let bits = val.to_bits();
                    // NOTE: Don't consider the sign or check that the subtraction will
                    //   underflow since we already checked that the value is greater
                    //   than 1.0.
                    let exponent = ((bits >> 52) & 0x7ff) - 1023;
                    let mantissa = (bits & 0x0f_ffff_ffff_ffff) | 0x10_0000_0000_0000;

                    if exponent <= 52 {
                        <$ty>::from(mantissa >> (52 - exponent))
                    } else if exponent < TY_BITS {
                        <$ty>::from(mantissa) << <$ty>::from(exponent - 52)
                    } else {
                        <$ty>::MAX
                    }
                } else {
                    <$ty>::zero()
                }
            }

            /// Lossy conversion of `$ty` to `f64`.
            pub fn to_f64_lossy(self) -> f64 {
                let mut acc = 0.0;
                for i in (0..self.0.len()).rev() {
                    acc += self.0[i] as f64 * 2.0f64.powi((i * <$ty>::WORD_BITS) as i32);
                }
                acc
            }
        }
    };
}

impl_f64_conversions!(U128);
impl_f64_conversions!(U256);
impl_f64_conversions!(U512);

#[cfg(feature = "ethers")]
macro_rules! impl_inner_conversion {
    ($a:ty, $b:ty) => {
        impl From<$a> for $b {
            fn from(val: $a) -> Self {
                Self(val.0)
            }
        }

        impl<'a> From<&'a $a> for $b {
            fn from(val: &'a $a) -> Self {
                Self(val.0)
            }
        }

        impl From<$b> for $a {
            fn from(val: $b) -> Self {
                Self(val.0)
            }
        }

        impl<'a> From<&'a $b> for $a {
            fn from(val: &'a $b) -> Self {
                Self(val.0)
            }
        }
    };
}

#[cfg(feature = "ethers")]
impl_inner_conversion!(H128, ethers_core::types::H128);
#[cfg(feature = "ethers")]
impl_inner_conversion!(H160, ethers_core::types::H160);
#[cfg(feature = "ethers")]
impl_inner_conversion!(H256, ethers_core::types::H256);
#[cfg(feature = "ethers")]
impl_inner_conversion!(H512, ethers_core::types::H512);
#[cfg(feature = "ethers")]
impl_inner_conversion!(U128, ethers_core::types::U128);
#[cfg(feature = "ethers")]
impl_inner_conversion!(U256, ethers_core::types::U256);
#[cfg(feature = "ethers")]
impl_inner_conversion!(U512, ethers_core::types::U512);
