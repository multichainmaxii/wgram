//! Test-only NEP-141 receiver for `ft_transfer_call`: keeps part of what it is sent
//! and hands the rest back, so tests can drive the wrapper's refund path.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, PromiseOrValue};

#[near(contract_state)]
#[derive(Default)]
pub struct MockFtReceiver {}

#[near]
impl MockFtReceiver {
    /// `msg` is the amount to hand back (empty keeps everything). It is deliberately
    /// not capped at `amount`, so tests can check that the token caps it.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = (sender_id, amount);
        let unused = if msg.is_empty() {
            0
        } else {
            msg.parse().unwrap_or_else(|_| env::panic_str("msg must be an amount"))
        };
        PromiseOrValue::Value(U128(unused))
    }
}
