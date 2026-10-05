//! Test-only NEP-245 multi-token standing in for HOT Bridge (`v2_1.omni.hot.tg`).
//! Implements the transfer paths the wrapper relies on, plus `mint` and a switch
//! to make plain transfers fail.

use near_sdk::store::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, PanicOnDefault,
    PromiseOrValue,
};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMt {
    balances: LookupMap<(AccountId, String), u128>,
    fail_transfers: bool,
}

#[ext_contract(ext_receiver)]
#[allow(dead_code)]
trait MtReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[near]
impl MockMt {
    #[init]
    pub fn new() -> Self {
        Self { balances: LookupMap::new(b"b"), fail_transfers: false }
    }

    pub fn mint(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        let key = (account_id, token_id);
        let balance = self.balance(&key);
        self.balances.insert(key, balance + amount.0);
    }

    pub fn set_fail_transfers(&mut self, fail: bool) {
        self.fail_transfers = fail;
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance(&(account_id, token_id)))
    }

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let _ = (approval, memo);
        require!(!self.fail_transfers, "transfers disabled");
        self.move_tokens(&env::predecessor_account_id(), &receiver_id, &token_id, amount.0);
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        let _ = (approval, memo);
        let sender_id = env::predecessor_account_id();
        self.move_tokens(&sender_id, &receiver_id, &token_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_tgas(30))
            .mt_on_transfer(sender_id.clone(), vec![sender_id.clone()], vec![token_id.clone()], vec![amount], msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .mt_resolve_transfer(sender_id, receiver_id, token_id, amount),
            )
            .into()
    }

    /// Refunds whatever the receiver reported as unused, like NEP-245's resolver.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
    ) -> Vec<U128> {
        let unused = match env::promise_result_checked(0, 1024) {
            Ok(value) => near_sdk::serde_json::from_slice::<Vec<U128>>(&value)
                .ok()
                .and_then(|refunds| refunds.first().copied())
                .map_or(amount.0, |r| r.0.min(amount.0)),
            Err(_) => amount.0,
        };
        let receiver_balance = self.balance(&(receiver_id.clone(), token_id.clone()));
        let refund = unused.min(receiver_balance);
        if refund > 0 {
            self.move_tokens(&receiver_id, &sender_id, &token_id, refund);
        }
        vec![U128(amount.0 - refund)]
    }
}

impl MockMt {
    fn balance(&self, key: &(AccountId, String)) -> u128 {
        self.balances.get(key).copied().unwrap_or(0)
    }

    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, token_id: &str, amount: u128) {
        require!(from != to, "sender and receiver must differ");
        let from_key = (from.clone(), token_id.to_string());
        let from_balance = self.balance(&from_key);
        require!(from_balance >= amount, "insufficient balance");
        self.balances.insert(from_key, from_balance - amount);
        let to_key = (to.clone(), token_id.to_string());
        let to_balance = self.balance(&to_key);
        self.balances.insert(to_key, to_balance + amount);
    }
}
