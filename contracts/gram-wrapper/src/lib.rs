//! GRAM wrapper: a 1:1 NEP-141 token backed by HOT Bridge's NEP-245 GRAM
//! (`v2_1.omni.hot.tg`, token id `1117_`).
//!
//! It exists because Omni Bridge only carries NEP-141 tokens to Solana, while
//! GRAM reaches NEAR from TON as a HOT NEP-245 multi-token.
//!
//! - Wrap: `mt_transfer_call` GRAM on the HOT contract to this contract. The same
//!   amount is minted to the sender (or to `receiver_id` given in `msg`).
//! - Unwrap: `unwrap` burns wrapped GRAM and sends HOT GRAM back. If that send
//!   fails, the burn is reverted.
//!
//! There is deliberately no owner, admin, mint, pause or upgrade method. Once the
//! account's access keys are deleted after deployment, nobody can change the code
//! or mint without backing, so `ft_total_supply` never exceeds this contract's
//! HOT GRAM balance.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const GAS_FOR_MT_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_FOR_ON_UNWRAP: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const IN_FLIGHT: &str = "Can't unregister while a transfer or unwrap is in flight";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    InFlight,
}

// Declared in `contract_source_metadata` (NEP-330), next to the repository link and
// build details that cargo-near bakes in.
#[near(contract_state, contract_metadata(
    standard(standard = "nep141", version = "1.0.0"),
    standard(standard = "nep145", version = "1.0.0"),
    standard(standard = "nep148", version = "1.0.0"),
))]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    /// The NEP-245 contract holding the backing asset (`v2_1.omni.hot.tg`).
    mt_contract: AccountId,
    /// The backing token id on `mt_contract` (`1117_` for GRAM).
    mt_token_id: String,
    /// Unsettled `ft_transfer_call`s and unwraps per account. While any are pending the
    /// account can't unregister, so a refund or a failed unwrap always has a registered
    /// account to return to (SECURITY.md, L1).
    in_flight: LookupMap<AccountId, u32>,
}

/// Optional `msg` for `mt_transfer_call`: mint to someone other than the sender.
#[near(serializers = [json])]
struct WrapMsg {
    receiver_id: AccountId,
}

#[ext_contract(ext_mt)]
#[allow(dead_code)]
trait MultiToken {
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

#[near]
impl Contract {
    #[init]
    pub fn new(mt_contract: AccountId, mt_token_id: String, metadata: FungibleTokenMetadata) -> Self {
        metadata.assert_valid();
        // Omni Bridge rejects tokens with an empty name or symbol.
        require!(
            !metadata.name.is_empty() && !metadata.symbol.is_empty(),
            "metadata needs a name and symbol"
        );
        require!(!mt_token_id.is_empty(), "mt_token_id is required");
        Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata,
            mt_contract,
            mt_token_id,
            in_flight: LookupMap::new(StorageKey::InFlight),
        }
    }

    /// NEP-245 receiver. Mints wrapped GRAM for each unit of the backing token
    /// received from `mt_contract` and returns everything else as a refund.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        let _ = previous_owner_ids;
        require!(token_ids.len() == amounts.len(), "token_ids and amounts differ in length");
        let refund_all = PromiseOrValue::Value(amounts.clone());

        // Only the real backing contract can mint. Anything else goes straight back.
        if env::predecessor_account_id() != self.mt_contract {
            return refund_all;
        }
        let receiver_id = if msg.is_empty() {
            sender_id
        } else {
            match near_sdk::serde_json::from_str::<WrapMsg>(&msg) {
                Ok(parsed) => parsed.receiver_id,
                Err(_) => return refund_all,
            }
        };
        // Refund rather than panic so the sender's GRAM is returned cleanly.
        if !self.token.accounts.contains_key(&receiver_id) {
            return refund_all;
        }

        let mut minted: u128 = 0;
        let refunds = token_ids
            .iter()
            .zip(amounts)
            .map(|(token_id, amount)| {
                if *token_id == self.mt_token_id {
                    minted = minted
                        .checked_add(amount.0)
                        .unwrap_or_else(|| env::panic_str("amount overflow"));
                    U128(0)
                } else {
                    amount
                }
            })
            .collect();

        if minted > 0 {
            self.token.internal_deposit(&receiver_id, minted);
            FtMint { owner_id: &receiver_id, amount: U128(minted), memo: Some("wrap") }.emit();
        }
        PromiseOrValue::Value(refunds)
    }

    /// Burns `amount` wrapped GRAM from the caller and sends the same amount of
    /// HOT GRAM to `receiver_id` (the caller by default).
    #[payable]
    pub fn unwrap(&mut self, amount: U128, receiver_id: Option<AccountId>) -> Promise {
        assert_one_yocto();
        require!(amount.0 > 0, "amount must be positive");
        let owner_id = env::predecessor_account_id();
        let receiver_id = receiver_id.unwrap_or_else(|| owner_id.clone());

        self.token.internal_withdraw(&owner_id, amount.0);
        FtBurn { owner_id: &owner_id, amount, memo: Some("unwrap") }.emit();
        self.begin_in_flight(&owner_id);

        ext_mt::ext(self.mt_contract.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_MT_TRANSFER)
            .mt_transfer(receiver_id, self.mt_token_id.clone(), amount, None, Some("unwrap".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_UNWRAP)
                    .on_unwrap(owner_id, amount),
            )
    }

    /// Reverts the burn if the HOT transfer failed, so a failed unwrap never loses funds.
    #[private]
    pub fn on_unwrap(&mut self, owner_id: AccountId, amount: U128) -> bool {
        self.end_in_flight(&owner_id);
        // Only an explicit failure reverts. A successful call that returned data
        // (TooLong) must never re-mint, or supply would exceed backing.
        if !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            return true;
        }
        // Unreachable while the in-flight guard holds; kept so a refund is never lost.
        if !self.token.accounts.contains_key(&owner_id) {
            self.token.internal_register_account(&owner_id);
        }
        self.token.internal_deposit(&owner_id, amount.0);
        FtMint { owner_id: &owner_id, amount, memo: Some("unwrap refund") }.emit();
        false
    }

    pub fn mt_contract(&self) -> AccountId {
        self.mt_contract.clone()
    }

    pub fn mt_token_id(&self) -> String {
        self.mt_token_id.clone()
    }
}

impl Contract {
    fn begin_in_flight(&mut self, account_id: &AccountId) {
        let pending = self.in_flight.get(account_id).unwrap_or(0);
        let pending = pending.checked_add(1).unwrap_or_else(|| env::panic_str("too many in flight"));
        self.in_flight.insert(account_id, &pending);
    }

    fn end_in_flight(&mut self, account_id: &AccountId) {
        match self.in_flight.get(account_id) {
            Some(pending) if pending > 1 => {
                self.in_flight.insert(account_id, &(pending - 1));
            }
            _ => {
                self.in_flight.remove(account_id);
            }
        }
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let out = self.token.ft_transfer_call(receiver_id, amount, memo, msg);
        self.begin_in_flight(&env::predecessor_account_id());
        out
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.end_in_flight(&sender_id);
        // The standard burns refunds owed to an unregistered sender, which would strand
        // their backing GRAM here forever. The in-flight guard keeps the sender registered,
        // so this re-registration is unreachable; it stays as a safety net.
        if !self.token.accounts.contains_key(&sender_id) {
            self.token.internal_register_account(&sender_id);
        }
        let (used_amount, _burned) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// `force` is ignored: force-unregistering burns the balance, which would leave
    /// backing GRAM stuck in this contract. Unwrap or transfer first. Also refused while
    /// the account has a transfer or unwrap in flight, so the contract never has to pay
    /// to re-register it for a refund.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let _ = force;
        assert_one_yocto();
        require!(!self.in_flight.contains_key(&env::predecessor_account_id()), IN_FLIGHT);
        self.token.storage_unregister(Some(false))
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::metadata::FT_METADATA_SPEC;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

    const GRAM: &str = "1117_";

    fn hot() -> AccountId {
        "v2_1.omni.hot.tg".parse().unwrap()
    }

    fn metadata() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Wrapped GRAM".to_string(),
            symbol: "wGRAM".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 9,
        }
    }

    fn setup() -> (Contract, VMContextBuilder) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id("gram.near".parse().unwrap());
        testing_env!(ctx.build());
        (Contract::new(hot(), GRAM.to_string(), metadata()), ctx)
    }

    fn register(contract: &mut Contract, ctx: &mut VMContextBuilder, account: AccountId) {
        let min = contract.storage_balance_bounds().min;
        testing_env!(ctx.predecessor_account_id(account).attached_deposit(min).build());
        contract.storage_deposit(None, None);
    }

    fn wrap(
        contract: &mut Contract,
        ctx: &mut VMContextBuilder,
        from_contract: AccountId,
        sender: AccountId,
        token_ids: &[&str],
        amounts: &[u128],
        msg: &str,
    ) -> Vec<u128> {
        testing_env!(ctx
            .predecessor_account_id(from_contract)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let out = contract.mt_on_transfer(
            sender.clone(),
            vec![sender],
            token_ids.iter().map(|t| t.to_string()).collect(),
            amounts.iter().map(|a| U128(*a)).collect(),
            msg.to_string(),
        );
        match out {
            PromiseOrValue::Value(refunds) => refunds.into_iter().map(|r| r.0).collect(),
            PromiseOrValue::Promise(_) => panic!("expected refunds, got a promise"),
        }
    }

    #[test]
    fn wraps_backing_token_one_to_one() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        let refunds = wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        assert_eq!(refunds, vec![0]);
        assert_eq!(c.ft_balance_of(accounts(0)).0, 400);
        assert_eq!(c.ft_total_supply().0, 400);
    }

    #[test]
    fn refunds_tokens_from_any_other_contract() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        let refunds = wrap(&mut c, &mut ctx, accounts(4), accounts(0), &[GRAM], &[400], "");
        assert_eq!(refunds, vec![400]);
        assert_eq!(c.ft_total_supply().0, 0);
    }

    #[test]
    fn refunds_other_token_ids_in_a_batch() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        let refunds =
            wrap(&mut c, &mut ctx, hot(), accounts(0), &["1111_", GRAM, "56_x"], &[5, 7, 9], "");
        assert_eq!(refunds, vec![5, 0, 9]);
        assert_eq!(c.ft_balance_of(accounts(0)).0, 7);
    }

    #[test]
    fn refunds_unregistered_receiver() {
        let (mut c, mut ctx) = setup();
        let refunds = wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        assert_eq!(refunds, vec![400]);
        assert_eq!(c.ft_total_supply().0, 0);
    }

    #[test]
    fn mints_to_receiver_named_in_msg() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(1));
        let msg = format!(r#"{{"receiver_id":"{}"}}"#, accounts(1));
        let refunds = wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[250], &msg);
        assert_eq!(refunds, vec![0]);
        assert_eq!(c.ft_balance_of(accounts(1)).0, 250);
        assert_eq!(c.ft_balance_of(accounts(0)).0, 0);
    }

    #[test]
    fn refunds_malformed_msg() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        let refunds = wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[250], "not json");
        assert_eq!(refunds, vec![250]);
    }

    #[test]
    fn unwrap_burns_before_sending() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        let _ = c.unwrap(U128(150), None);
        assert_eq!(c.ft_balance_of(accounts(0)).0, 250);
        assert_eq!(c.ft_total_supply().0, 250);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn unwrap_requires_one_yocto() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        testing_env!(ctx
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = c.unwrap(U128(1), None);
    }

    #[test]
    #[should_panic(expected = "The account doesn't have enough balance")]
    fn unwrap_more_than_balance_fails() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[10], "");
        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        let _ = c.unwrap(U128(11), None);
    }

    #[test]
    fn failed_unwrap_is_reverted() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        let _ = c.unwrap(U128(150), None);

        let self_id: AccountId = "gram.near".parse().unwrap();
        testing_env!(
            ctx.predecessor_account_id(self_id).attached_deposit(NearToken::from_yoctonear(0)).build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        assert!(!c.on_unwrap(accounts(0), U128(150)));
        assert_eq!(c.ft_balance_of(accounts(0)).0, 400);
        assert_eq!(c.ft_total_supply().0, 400);
    }

    #[test]
    fn successful_unwrap_returning_data_does_not_remint() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        let _ = c.unwrap(U128(150), None);

        let self_id: AccountId = "gram.near".parse().unwrap();
        testing_env!(
            ctx.predecessor_account_id(self_id).attached_deposit(NearToken::from_yoctonear(0)).build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(b"\"150\"".to_vec())],
        );
        assert!(c.on_unwrap(accounts(0), U128(150)));
        assert_eq!(c.ft_balance_of(accounts(0)).0, 250);
        assert_eq!(c.ft_total_supply().0, 250);
    }

    #[test]
    #[should_panic(expected = "Can't unregister the account with the positive balance without force")]
    fn cannot_force_unregister_with_balance() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        c.storage_unregister(Some(true));
    }

    #[test]
    #[should_panic(expected = "Can't unregister while a transfer or unwrap is in flight")]
    fn cannot_unregister_with_unwrap_in_flight() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        let _ = c.unwrap(U128(400), None);
        c.storage_unregister(None);
    }

    #[test]
    #[should_panic(expected = "Can't unregister while a transfer or unwrap is in flight")]
    fn cannot_unregister_with_transfer_call_in_flight() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        register(&mut c, &mut ctx, accounts(1));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        let _ = c.ft_transfer_call(accounts(1), U128(400), None, String::new());
        c.storage_unregister(None);
    }

    #[test]
    fn can_unregister_once_unwrap_settles() {
        let (mut c, mut ctx) = setup();
        register(&mut c, &mut ctx, accounts(0));
        wrap(&mut c, &mut ctx, hot(), accounts(0), &[GRAM], &[400], "");
        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        let _ = c.unwrap(U128(400), None);

        let self_id: AccountId = "gram.near".parse().unwrap();
        testing_env!(
            ctx.predecessor_account_id(self_id).attached_deposit(NearToken::from_yoctonear(0)).build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(vec![])],
        );
        assert!(c.on_unwrap(accounts(0), U128(400)));

        testing_env!(ctx.predecessor_account_id(accounts(0)).attached_deposit(ONE_YOCTO).build());
        assert!(c.storage_unregister(None));
        assert!(c.storage_balance_of(accounts(0)).is_none());
    }

    #[test]
    #[should_panic(expected = "metadata needs a name and symbol")]
    fn rejects_empty_symbol() {
        let mut m = metadata();
        m.symbol = String::new();
        testing_env!(VMContextBuilder::new().build());
        Contract::new(hot(), GRAM.to_string(), m);
    }
}
