//! Property tests: random sequences of wraps, unwraps, transfers and storage calls,
//! run on near-sdk's mocked blockchain against a small model of the wrapper and of
//! the GRAM it holds on HOT. A call that panics is rolled back like a failed
//! receipt. After every step the contract must match the model, panic only where the
//! model says it must (and for the same reason), and stay fully backed.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::fmt::Debug;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

use gram_wrapper::Contract;
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::json_types::U128;
use near_sdk::mock::{with_mocked_blockchain, MockAction, Receipt};
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::{
    borsh, env, AccountId, MockedBlockchain, NearToken, PromiseOrValue, PromiseResult,
    RuntimeFeesConfig, VMContext,
};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use serde_json::json;

const GRAM: &str = "1117_";
const USERS: usize = 4;
const ONE_YOCTO: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
const NOT_REGISTERED: &str = "is not registered";
const NO_BALANCE: &str = "The account doesn't have enough balance";
const STILL_HOLDS: &str = "Can't unregister the account with the positive balance without force";
const IN_FLIGHT: &str = "Can't unregister while a transfer or unwrap is in flight";

type Storage = HashMap<Vec<u8>, Vec<u8>>;

fn wrapper() -> AccountId {
    "gram.near".parse().unwrap()
}

fn hot() -> AccountId {
    "v2_1.omni.hot.tg".parse().unwrap()
}

fn user(i: usize) -> AccountId {
    accounts(i)
}

/// Accounts other than HOT that call the NEP-245 hook anyway.
fn impostor_id(i: usize) -> AccountId {
    match i {
        0 => "fake-hot.near".parse().unwrap(),
        1 => user(0),
        _ => wrapper(),
    }
}

#[derive(Clone, Copy, Debug)]
enum Amount {
    All,
    /// `n`/255 of the balance it applies to, so most generated transfers can succeed.
    Share(u8),
    /// Any amount, including 0 and values near `u128::MAX`.
    Exactly(u128),
}

impl Amount {
    fn of(self, total: u128) -> u128 {
        match self {
            Amount::All => total,
            Amount::Share(n) => total / 255 * n as u128 + total % 255 * n as u128 / 255,
            Amount::Exactly(amount) => amount,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Token {
    Gram,
    Other(&'static str),
}

#[derive(Clone, Debug)]
enum Msg {
    Empty,
    Receiver(usize),
    ReceiverAndMore(usize),
    Garbage(&'static str),
}

impl Msg {
    fn render(&self) -> String {
        match self {
            Msg::Empty => String::new(),
            Msg::Receiver(r) => json!({ "receiver_id": user(*r) }).to_string(),
            Msg::ReceiverAndMore(r) => {
                json!({ "receiver_id": user(*r), "note": "ignored" }).to_string()
            }
            Msg::Garbage(msg) => msg.to_string(),
        }
    }

    /// Who the wrap mints to, if the message is understood.
    fn receiver(&self, sender: usize) -> Option<usize> {
        match self {
            Msg::Empty => Some(sender),
            Msg::Receiver(r) | Msg::ReceiverAndMore(r) => Some(*r),
            Msg::Garbage(_) => None,
        }
    }
}

/// How HOT's `mt_transfer` for an unwrap ends.
#[derive(Clone, Copy, Debug)]
enum Hot {
    Sent,
    SentWithData,
    Failed,
}

/// What the receiver of an `ft_transfer_call` answers.
#[derive(Clone, Copy, Debug)]
enum Answer {
    Unused(Amount),
    Garbage,
    Failed,
}

#[derive(Clone, Copy, Debug)]
enum Deposit {
    Min,
    Extra(u128),
    Short,
    Zero,
}

#[derive(Clone, Debug)]
enum Op {
    /// `mt_on_transfer` from HOT, or from an impostor.
    Wrap {
        impostor: Option<usize>,
        sender: usize,
        tokens: Vec<(Token, u128)>,
        msg: Msg,
    },
    /// `leave`: the owner also tries to unregister in the same transaction, before HOT
    /// answers. The in-flight guard refuses it, so the whole transaction reverts.
    Unwrap {
        owner: usize,
        amount: Amount,
        receiver: Option<usize>,
        yocto: u128,
        leave: bool,
    },
    /// HOT runs the `mt_transfer` of a pending unwrap, then `on_unwrap` runs.
    SettleUnwrap {
        pick: usize,
        outcome: Hot,
    },
    Transfer {
        sender: usize,
        receiver: usize,
        amount: Amount,
        yocto: u128,
    },
    /// `leave`: the sender also tries to unregister in the same transaction, before the
    /// receiver answers. The in-flight guard refuses it, so the whole transaction reverts.
    TransferCall {
        sender: usize,
        receiver: usize,
        amount: Amount,
        yocto: u128,
        leave: bool,
    },
    /// The receiver of a pending `ft_transfer_call` answers, then `ft_resolve_transfer` runs.
    SettleCall {
        pick: usize,
        answer: Answer,
    },
    Register {
        caller: usize,
        account: Option<usize>,
        deposit: Deposit,
        registration_only: Option<bool>,
    },
    Unregister {
        account: usize,
        force: Option<bool>,
        yocto: u128,
    },
    Withdraw {
        account: usize,
        amount: Option<u128>,
        yocto: u128,
    },
}

fn raw() -> impl Strategy<Value = u128> {
    prop_oneof![
        2 => Just(0),
        6 => 1..=1_000_000_000_000u128,
        1 => u64::MAX as u128..=u128::MAX,
        1 => u128::MAX - 1_000..=u128::MAX,
    ]
}

fn amount() -> impl Strategy<Value = Amount> {
    prop_oneof![
        3 => any::<u8>().prop_map(Amount::Share),
        3 => Just(Amount::All),
        1 => raw().prop_map(Amount::Exactly),
    ]
}

fn yocto() -> impl Strategy<Value = u128> {
    prop_oneof![16 => Just(1), 1 => Just(0), 1 => Just(2)]
}

fn wrap_op(impostor: impl Strategy<Value = Option<usize>>) -> impl Strategy<Value = Op> {
    let token = prop_oneof![
        5 => Just(Token::Gram),
        1 => prop::sample::select(vec!["1111_", "1117", "1117__", "nep141:wrap.near"])
            .prop_map(Token::Other),
    ];
    let msg = prop_oneof![
        4 => Just(Msg::Empty),
        2 => (0..USERS).prop_map(Msg::Receiver),
        1 => (0..USERS).prop_map(Msg::ReceiverAndMore),
        1 => prop::sample::select(vec![
            "not json",
            "{}",
            " ",
            "null",
            r#"{"receiver_id":7}"#,
            r#"{"receiver_id":"Not An Account"}"#,
        ])
        .prop_map(Msg::Garbage),
    ];
    (impostor, 0..USERS, prop::collection::vec((token, raw()), 1..4), msg)
        .prop_map(|(impostor, sender, tokens, msg)| Op::Wrap { impostor, sender, tokens, msg })
}

fn op() -> impl Strategy<Value = Op> {
    let user = || 0..USERS;
    let hot =
        prop_oneof![2 => Just(Hot::Sent), 1 => Just(Hot::SentWithData), 3 => Just(Hot::Failed)];
    let answer = prop_oneof![
        4 => amount().prop_map(Answer::Unused),
        2 => Just(Answer::Unused(Amount::Exactly(u128::MAX))),
        1 => Just(Answer::Garbage),
        1 => Just(Answer::Failed),
    ];
    let deposit = prop_oneof![
        6 => Just(Deposit::Min),
        1 => (1..=10u128.pow(24)).prop_map(Deposit::Extra),
        1 => Just(Deposit::Short),
        1 => Just(Deposit::Zero),
    ];
    prop_oneof![
        4 => wrap_op(prop::option::weighted(0.2, 0..3usize)),
        3 => (user(), amount(), prop::option::of(user()), yocto(), prop::bool::weighted(0.25))
            .prop_map(|(owner, amount, receiver, yocto, leave)| Op::Unwrap {
                owner,
                amount,
                receiver,
                yocto,
                leave,
            }),
        2 => (any::<usize>(), hot).prop_map(|(pick, outcome)| Op::SettleUnwrap { pick, outcome }),
        2 => (user(), user(), amount(), yocto())
            .prop_map(|(sender, receiver, amount, yocto)| Op::Transfer {
                sender,
                receiver,
                amount,
                yocto,
            }),
        3 => (user(), user(), amount(), yocto(), prop::bool::weighted(0.25))
            .prop_map(|(sender, receiver, amount, yocto, leave)| Op::TransferCall {
                sender,
                receiver,
                amount,
                yocto,
                leave,
            }),
        2 => (any::<usize>(), answer).prop_map(|(pick, answer)| Op::SettleCall { pick, answer }),
        3 => (user(), prop::option::weighted(0.3, user()), deposit, prop::option::of(any::<bool>()))
            .prop_map(|(caller, account, deposit, registration_only)| Op::Register {
                caller,
                account,
                deposit,
                registration_only,
            }),
        4 => (user(), prop::option::of(any::<bool>()), yocto())
            .prop_map(|(account, force, yocto)| Op::Unregister { account, force, yocto }),
        1 => (user(), prop::option::of(prop_oneof![Just(0u128), 1..=u128::MAX]), yocto())
            .prop_map(|(account, amount, yocto)| Op::Withdraw { account, amount, yocto }),
    ]
}

/// The wrapper as it should be, plus the GRAM it holds on HOT.
#[derive(Default)]
struct Model {
    /// Registered accounts (by user index) and their wGRAM balances.
    balances: BTreeMap<usize, u128>,
    supply: u128,
    /// GRAM the wrapper holds on HOT.
    backing: u128,
    /// Unwraps burned here whose HOT transfer hasn't settled: (owner, amount).
    unwraps: Vec<(usize, u128)>,
    /// `ft_transfer_call`s waiting on their receiver: (sender, receiver, amount).
    calls: Vec<(usize, usize, u128)>,
}

impl Model {
    fn registered(&self, i: usize) -> bool {
        self.balances.contains_key(&i)
    }

    fn balance(&self, i: usize) -> u128 {
        self.balances.get(&i).copied().unwrap_or(0)
    }

    /// Registers `i` first if needed, which is how the wrapper treats refunds.
    fn credit(&mut self, i: usize, amount: u128) {
        *self.balances.entry(i).or_default() += amount;
    }

    fn debit(&mut self, i: usize, amount: u128) {
        *self.balances.get_mut(&i).unwrap() -= amount;
    }

    /// Whether `i` has an unwrap or `ft_transfer_call` that hasn't settled.
    fn in_flight(&self, i: usize) -> bool {
        self.unwraps.iter().any(|(owner, _)| *owner == i)
            || self.calls.iter().any(|(sender, _, _)| *sender == i)
    }
}

/// Counts how often each path that matters was reached, so a run can't pass vacuously.
#[derive(Default)]
struct Seen(BTreeMap<&'static str, u32>);

impl Seen {
    fn hit(&mut self, path: &'static str) {
        *self.0.entry(path).or_default() += 1;
    }

    fn assert_reached(&self, paths: &[&str]) {
        let missed: Vec<_> = paths.iter().filter(|p| !self.0.contains_key(**p)).collect();
        assert!(missed.is_empty(), "never reached {missed:?}; reached {:?}", self.0);
    }
}

thread_local! {
    static QUIET: Cell<bool> = const { Cell::new(false) };
    /// Building the VM config parses the protocol parameters, so do it once per thread.
    static CHAIN: Box<dyn Fn(VMContext, Vec<PromiseResult>, Storage) -> MockedBlockchain> = {
        let config = near_sdk::test_vm_config();
        let fees = RuntimeFeesConfig::test();
        Box::new(move |context, results, storage| {
            let (config, fees) = (config.clone(), fees.clone());
            MockedBlockchain::new(context, config, fees, results, storage, HashMap::new(), None)
        })
    };
}

fn set_chain(
    predecessor: &AccountId,
    deposit: u128,
    results: Vec<PromiseResult>,
    storage: Storage,
) {
    let context = VMContextBuilder::new()
        .current_account_id(wrapper())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build();
    env::set_blockchain_interface(CHAIN.with(|chain| chain(context, results, storage)));
}

/// Contract panics the model expects are caught and checked; keep them out of the
/// output while leaving genuine failures visible.
fn quiet_expected_panics() {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !QUIET.with(Cell::get) {
                default(info);
            }
        }));
    });
}

struct World {
    contract: Contract,
    model: Model,
    /// False when HOT is assumed to call the hook with batches it could never have
    /// delivered. Backing isn't tracked then, only the wrapper's own arithmetic.
    honest_hot: bool,
    min_storage: u128,
    seen: Seen,
}

impl World {
    fn new(honest_hot: bool) -> Self {
        quiet_expected_panics();
        set_chain(&wrapper(), 0, vec![], Storage::new());
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Wrapped GRAM".to_string(),
            symbol: "wGRAM".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 9,
        };
        let contract = Contract::new(hot(), GRAM.to_string(), metadata);
        let min_storage = contract.storage_balance_bounds().min.as_yoctonear();
        Self { contract, model: Model::default(), honest_hot, min_storage, seen: Seen::default() }
    }

    /// Runs `f` as a receipt from `predecessor`. A panic reverts its state changes, as
    /// it would on chain, and comes back as the panic message.
    fn call<R>(
        &mut self,
        predecessor: &AccountId,
        deposit: u128,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        let storage = with_mocked_blockchain(|b| b.take_storage());
        let saved = (borsh::to_vec(&self.contract).unwrap(), storage.clone());
        set_chain(predecessor, deposit, results, storage);
        QUIET.with(|q| q.set(true));
        let out = catch_unwind(AssertUnwindSafe(|| f(&mut self.contract)));
        QUIET.with(|q| q.set(false));
        out.map_err(|payload| {
            self.contract = borsh::from_slice(&saved.0).unwrap();
            set_chain(&wrapper(), 0, vec![], saved.1);
            self.seen.hit("panic rolled back");
            payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default()
        })
    }

    fn step(&mut self, op: &Op) {
        match *op {
            Op::Wrap { impostor, sender, ref tokens, ref msg } => {
                self.wrap(op, impostor, sender, tokens, msg)
            }
            Op::Unwrap { owner, amount, receiver, yocto, leave } => {
                self.unwrap(op, owner, amount, receiver, yocto, leave)
            }
            Op::SettleUnwrap { pick, outcome } => self.settle_unwrap(op, pick, outcome),
            Op::Transfer { sender, receiver, amount, yocto } => {
                self.transfer(op, sender, receiver, amount, yocto, None)
            }
            Op::TransferCall { sender, receiver, amount, yocto, leave } => {
                self.transfer(op, sender, receiver, amount, yocto, Some(leave))
            }
            Op::SettleCall { pick, answer } => self.settle_call(op, pick, answer),
            Op::Register { caller, account, deposit, registration_only } => {
                self.register(op, caller, account, deposit, registration_only)
            }
            Op::Unregister { account, force, yocto } => self.unregister(op, account, force, yocto),
            Op::Withdraw { account, amount, yocto } => self.withdraw(op, account, amount, yocto),
        }
        self.check(op);
    }

    fn wrap(
        &mut self,
        op: &Op,
        impostor: Option<usize>,
        sender: usize,
        tokens: &[(Token, u128)],
        msg: &Msg,
    ) {
        let gram = tokens
            .iter()
            .filter(|(token, _)| *token == Token::Gram)
            .try_fold(0u128, |sum, (_, amount)| sum.checked_add(*amount));
        if impostor.is_none()
            && self.honest_hot
            && gram.and_then(|g| self.model.backing.checked_add(g)).is_none()
        {
            // HOT can't credit the wrapper with GRAM that doesn't exist, so it never calls.
            return;
        }
        // Some only when the wrapper should mint.
        let receiver =
            msg.receiver(sender).filter(|r| impostor.is_none() && self.model.registered(*r));
        let expected = match (receiver, gram) {
            (None, _) => Ok(()),
            (Some(_), None) => Err("amount overflow"),
            (Some(r), Some(g)) if self.model.balance(r).checked_add(g).is_none() => {
                Err("Balance overflow")
            }
            (Some(_), Some(g)) if self.model.supply.checked_add(g).is_none() => {
                Err("Total supply overflow")
            }
            _ => Ok(()),
        };
        if expected.is_err() {
            self.seen.hit("oversized wrap rejected");
        }
        let caller = impostor.map_or_else(hot, impostor_id);
        let ids = tokens.iter().map(|(token, _)| match token {
            Token::Gram => GRAM.to_string(),
            Token::Other(id) => id.to_string(),
        });
        let amounts = tokens.iter().map(|(_, amount)| U128(*amount)).collect();
        let actual = self.call(&caller, 0, vec![], |c| {
            let owners = vec![user(sender); tokens.len()];
            match c.mt_on_transfer(user(sender), owners, ids.collect(), amounts, msg.render()) {
                PromiseOrValue::Value(refunds) => {
                    Some(refunds.into_iter().map(|r| r.0).collect::<Vec<_>>())
                }
                PromiseOrValue::Promise(_) => None,
            }
        });
        assert_outcome(op, expected, &actual);
        let Ok(refunds) = actual else { return };
        let kept = |token: &Token| receiver.is_some() && *token == Token::Gram;
        let want: Vec<_> = tokens.iter().map(|(t, a)| if kept(t) { 0 } else { *a }).collect();
        assert_eq!(refunds, Some(want), "{op:?}: refunds");
        match (receiver, gram) {
            (Some(r), Some(minted)) if minted > 0 => {
                // HOT keeps with the wrapper exactly the GRAM it wasn't refunded.
                self.model.credit(r, minted);
                self.model.supply += minted;
                if self.honest_hot {
                    self.model.backing += minted;
                }
                self.seen.hit("wrap minted");
                if minted > u64::MAX as u128 {
                    self.seen.hit("wrap minted above u64::MAX");
                }
            }
            (Some(_), _) => {}
            (None, _) => self.seen.hit("wrap refunded"),
        }
    }

    fn unwrap(
        &mut self,
        op: &Op,
        owner: usize,
        amount: Amount,
        receiver: Option<usize>,
        yocto: u128,
        leave: bool,
    ) {
        let balance = self.model.balance(owner);
        let amount = amount.of(balance);
        let expected = if yocto != 1 {
            Err(ONE_YOCTO)
        } else if amount == 0 {
            Err("amount must be positive")
        } else if !self.model.registered(owner) {
            Err(NOT_REGISTERED)
        } else if balance < amount {
            Err(NO_BALANCE)
        } else if leave {
            Err(IN_FLIGHT)
        } else {
            Ok(())
        };
        if expected == Err(IN_FLIGHT) {
            self.seen.hit("unregister refused while in flight");
        }
        let actual = self.call(&user(owner), yocto, vec![], |c| {
            drop(c.unwrap(U128(amount), receiver.map(user)));
            let receipts = get_created_receipts();
            (receipts, leave && c.storage_unregister(None))
        });
        assert_outcome(op, expected, &actual);
        let Ok((receipts, left)) = actual else { return };
        assert_unwrap_receipts(op, &receipts, owner, receiver.unwrap_or(owner), amount);
        assert_eq!(left, leave, "{op:?}: unregistered");
        self.model.debit(owner, amount);
        self.model.supply -= amount;
        self.model.unwraps.push((owner, amount));
    }

    fn settle_unwrap(&mut self, op: &Op, pick: usize, outcome: Hot) {
        if self.model.unwraps.is_empty() {
            return;
        }
        let (owner, amount) = self.model.unwraps.remove(pick % self.model.unwraps.len());
        let result = match outcome {
            Hot::Sent => PromiseResult::Successful(vec![]),
            Hot::SentWithData => PromiseResult::Successful(b"\"done\"".to_vec()),
            Hot::Failed => PromiseResult::Failed,
        };
        let sent = !matches!(outcome, Hot::Failed);
        let actual =
            self.call(&wrapper(), 0, vec![result], |c| c.on_unwrap(user(owner), U128(amount)));
        assert_eq!(actual, Ok(sent), "{op:?}: on_unwrap");
        if sent {
            // HOT paid the receiver, so the wrapper holds that much less GRAM.
            self.model.backing -= amount;
            self.seen.hit("unwrap sent");
        } else {
            assert!(self.model.registered(owner), "{op:?}: owner left with an unwrap in flight");
            self.model.credit(owner, amount);
            self.model.supply += amount;
            self.seen.hit("unwrap reverted");
        }
    }

    /// `call` is None for `ft_transfer`, else `ft_transfer_call` with the op's `leave`.
    fn transfer(
        &mut self,
        op: &Op,
        sender: usize,
        receiver: usize,
        amount: Amount,
        yocto: u128,
        call: Option<bool>,
    ) {
        let balance = self.model.balance(sender);
        let amount = amount.of(balance);
        let leave = call == Some(true);
        let expected = if yocto != 1 {
            Err(ONE_YOCTO)
        } else if sender == receiver {
            Err("Sender and receiver should be different")
        } else if amount == 0 {
            Err("The amount should be a positive number")
        } else if !self.model.registered(sender) {
            Err(NOT_REGISTERED)
        } else if balance < amount {
            Err(NO_BALANCE)
        } else if !self.model.registered(receiver) {
            Err(NOT_REGISTERED)
        } else if leave {
            Err(IN_FLIGHT)
        } else {
            Ok(())
        };
        if expected == Err(IN_FLIGHT) {
            self.seen.hit("unregister refused while in flight");
        }
        let actual = self.call(&user(sender), yocto, vec![], |c| {
            let handed_off = match call {
                Some(_) => {
                    let out = c.ft_transfer_call(user(receiver), U128(amount), None, String::new());
                    matches!(out, PromiseOrValue::Promise(_))
                }
                None => {
                    c.ft_transfer(user(receiver), U128(amount), None);
                    true
                }
            };
            (handed_off, leave && c.storage_unregister(None))
        });
        assert_outcome(op, expected, &actual);
        let Ok((handed_off, left)) = actual else { return };
        assert!(handed_off, "{op:?}: ft_transfer_call must call the receiver");
        assert_eq!(left, leave, "{op:?}: unregistered");
        self.model.debit(sender, amount);
        self.model.credit(receiver, amount);
        if call.is_some() {
            self.model.calls.push((sender, receiver, amount));
        }
    }

    fn settle_call(&mut self, op: &Op, pick: usize, answer: Answer) {
        if self.model.calls.is_empty() {
            return;
        }
        let (sender, receiver, amount) = self.model.calls.remove(pick % self.model.calls.len());
        let (result, unused) = match answer {
            Answer::Unused(claim) => {
                let claimed = claim.of(amount);
                if claimed > amount {
                    self.seen.hit("refund capped at the amount sent");
                }
                let result = PromiseResult::Successful(format!("\"{claimed}\"").into_bytes());
                (result, claimed.min(amount))
            }
            Answer::Garbage => (PromiseResult::Successful(b"\"most of it\"".to_vec()), amount),
            Answer::Failed => (PromiseResult::Failed, amount),
        };
        // Only what the receiver still holds can come back.
        let refund = unused.min(self.model.balance(receiver));
        let actual = self.call(&wrapper(), 0, vec![result], |c| {
            c.ft_resolve_transfer(user(sender), user(receiver), U128(amount)).0
        });
        assert_eq!(actual, Ok(amount - refund), "{op:?}: used amount");
        if refund > 0 && refund < amount {
            self.seen.hit("partial refund");
        }
        // The in-flight guard kept the sender registered, so the refund always lands.
        assert!(self.model.registered(sender), "{op:?}: sender left with a call in flight");
        self.model.credit(sender, refund);
        if refund > 0 {
            self.model.debit(receiver, refund);
        }
    }

    fn register(
        &mut self,
        op: &Op,
        caller: usize,
        account: Option<usize>,
        deposit: Deposit,
        registration_only: Option<bool>,
    ) {
        let target = account.unwrap_or(caller);
        let attached = match deposit {
            Deposit::Min => self.min_storage,
            Deposit::Extra(extra) => self.min_storage + extra,
            Deposit::Short => self.min_storage - 1,
            Deposit::Zero => 0,
        };
        let expected = if !self.model.registered(target) && attached < self.min_storage {
            Err("The attached deposit is less than the minimum storage balance")
        } else {
            Ok(())
        };
        let actual = self.call(&user(caller), attached, vec![], |c| {
            let balance = c.storage_deposit(account.map(user), registration_only);
            (balance.total.as_yoctonear(), balance.available.as_yoctonear())
        });
        assert_outcome(op, expected, &actual);
        let Ok(balance) = actual else { return };
        assert_eq!(balance, (self.min_storage, 0), "{op:?}: storage balance");
        self.model.balances.entry(target).or_default();
    }

    fn unregister(&mut self, op: &Op, account: usize, force: Option<bool>, yocto: u128) {
        // `force` must never matter: a positive balance always blocks unregistering.
        let expected = if yocto != 1 {
            Err(ONE_YOCTO)
        } else if self.model.in_flight(account) {
            Err(IN_FLIGHT)
        } else if self.model.balance(account) > 0 {
            Err(STILL_HOLDS)
        } else {
            Ok(())
        };
        if expected == Err(IN_FLIGHT) {
            self.seen.hit("unregister refused while in flight");
        }
        let actual = self.call(&user(account), yocto, vec![], |c| c.storage_unregister(force));
        assert_outcome(op, expected, &actual);
        let Ok(removed) = actual else { return };
        assert_eq!(removed, self.model.registered(account), "{op:?}: unregistered");
        self.model.balances.remove(&account);
    }

    fn withdraw(&mut self, op: &Op, account: usize, amount: Option<u128>, yocto: u128) {
        let expected = if yocto != 1 {
            Err(ONE_YOCTO)
        } else if !self.model.registered(account) {
            Err(NOT_REGISTERED)
        } else if amount.is_some_and(|a| a > 0) {
            Err("The amount is greater than the available storage balance")
        } else {
            Ok(())
        };
        let actual = self.call(&user(account), yocto, vec![], |c| {
            let balance = c.storage_withdraw(amount.map(NearToken::from_yoctonear));
            (balance.total.as_yoctonear(), balance.available.as_yoctonear())
        });
        assert_outcome(op, expected, &actual);
        if let Ok(balance) = actual {
            assert_eq!(balance, (self.min_storage, 0), "{op:?}: storage balance");
        }
    }

    /// Settles everything still in flight; then supply must equal backing exactly.
    fn drain(&mut self, mut seed: u64) {
        while !self.model.calls.is_empty() {
            let answer = match seed % 3 {
                0 => Answer::Unused(Amount::Share(128)),
                1 => Answer::Unused(Amount::All),
                _ => Answer::Failed,
            };
            seed = seed.rotate_right(7);
            self.step(&Op::SettleCall { pick: 0, answer });
        }
        while !self.model.unwraps.is_empty() {
            let outcome = if seed & 1 == 0 { Hot::Sent } else { Hot::Failed };
            seed = seed.rotate_right(1);
            self.step(&Op::SettleUnwrap { pick: 0, outcome });
        }
        self.view();
        assert_eq!(
            self.contract.ft_total_supply().0,
            self.model.backing,
            "nothing in flight: supply must equal the GRAM held"
        );
    }

    /// A fresh context for views, so they never share a gas budget with a call.
    fn view(&self) {
        let storage = with_mocked_blockchain(|b| b.take_storage());
        set_chain(&wrapper(), 0, vec![], storage);
    }

    fn check(&mut self, op: &Op) {
        self.view();
        let supply = self.contract.ft_total_supply().0;
        assert_eq!(supply, self.model.supply, "after {op:?}: supply");
        if self.honest_hot {
            // Burned but not yet paid out by HOT: still held, no longer in supply.
            let in_flight: u128 = self.model.unwraps.iter().map(|(_, amount)| amount).sum();
            assert_eq!(
                supply.checked_add(in_flight),
                Some(self.model.backing),
                "after {op:?}: supply plus unwraps in flight must equal the GRAM held"
            );
        }
        let mut total = 0u128;
        for i in 0..USERS {
            let balance = self.contract.ft_balance_of(user(i)).0;
            assert_eq!(balance, self.model.balance(i), "after {op:?}: balance of {}", user(i));
            assert!(balance <= supply, "after {op:?}: {} holds more than the supply", user(i));
            assert_eq!(
                self.contract.storage_balance_of(user(i)).is_some(),
                self.model.registered(i),
                "after {op:?}: registration of {}",
                user(i)
            );
            total = total.checked_add(balance).expect("balances overflow");
        }
        assert_eq!(total, supply, "after {op:?}: balances must add up to the supply");
    }
}

/// The call must panic exactly when the model says so, and for the stated reason.
fn assert_outcome<T: Debug>(op: &Op, expected: Result<(), &str>, actual: &Result<T, String>) {
    match (expected, actual) {
        (Ok(()), Ok(_)) => {}
        (Err(want), Err(got)) => {
            assert!(got.contains(want), "{op:?}: expected a panic with {want:?}, got {got:?}")
        }
        (expected, actual) => panic!("{op:?}: expected {expected:?}, got {actual:?}"),
    }
}

/// `unwrap` must send exactly `amount` of the backing token to `receiver` on HOT,
/// with `on_unwrap` for the owner chained after it.
fn assert_unwrap_receipts(
    op: &Op,
    receipts: &[Receipt],
    owner: usize,
    receiver: usize,
    amount: u128,
) {
    let [transfer, callback] = receipts else {
        panic!("{op:?}: expected two receipts, got {receipts:?}")
    };
    assert_eq!(transfer.receiver_id, hot(), "{op:?}");
    assert_eq!(
        function_call(transfer),
        (
            "mt_transfer".to_string(),
            json!({
                "receiver_id": user(receiver),
                "token_id": GRAM,
                "amount": amount.to_string(),
                "approval": null,
                "memo": "unwrap",
            }),
            NearToken::from_yoctonear(1),
        ),
        "{op:?}"
    );
    assert_eq!(callback.receiver_id, wrapper(), "{op:?}");
    assert_eq!(callback.receipt_indices, vec![0], "{op:?}: on_unwrap must wait for the transfer");
    assert_eq!(
        function_call(callback),
        (
            "on_unwrap".to_string(),
            json!({ "owner_id": user(owner), "amount": amount.to_string() }),
            NearToken::from_yoctonear(0),
        ),
        "{op:?}"
    );
}

fn function_call(receipt: &Receipt) -> (String, serde_json::Value, NearToken) {
    match &receipt.actions[..] {
        [MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. }] => (
            String::from_utf8(method_name.clone()).unwrap(),
            serde_json::from_slice(args).unwrap(),
            *attached_deposit,
        ),
        actions => panic!("expected one function call, got {actions:?}"),
    }
}

/// Runs `cases` generated cases and shrinks any failure to a minimal one.
fn run<S: Strategy>(cases: u32, strategy: S, test: impl Fn(S::Value))
where
    S::Value: Debug,
{
    let config = Config { cases, failure_persistence: None, ..Config::default() };
    if let Err(err) = TestRunner::new(config).run(&strategy, |value| {
        test(value);
        Ok(())
    }) {
        panic!("{err}");
    }
}

#[test]
fn random_operations_keep_wgram_fully_backed() {
    let seen = RefCell::new(Seen::default());
    let strategy = (
        prop::array::uniform4(prop::bool::weighted(0.75)),
        prop::collection::vec(op(), 1..48),
        any::<u64>(),
    );
    run(1024, strategy, |(registered, ops, seed)| {
        let mut world = World::new(true);
        for (caller, _) in registered.iter().enumerate().filter(|(_, r)| **r) {
            let deposit = Deposit::Min;
            world.step(&Op::Register { caller, account: None, deposit, registration_only: None });
        }
        for op in &ops {
            world.step(op);
        }
        world.drain(seed);
        let mut seen = seen.borrow_mut();
        for (path, n) in world.seen.0 {
            *seen.0.entry(path).or_default() += n;
        }
    });
    seen.into_inner().assert_reached(&[
        "wrap minted",
        "wrap minted above u64::MAX",
        "wrap refunded",
        "unwrap sent",
        "unwrap reverted",
        "partial refund",
        "refund capped at the amount sent",
        "unregister refused while in flight",
        "panic rolled back",
    ]);
}

#[test]
fn oversized_wraps_never_overflow() {
    // Even if HOT called the hook with batches it could never have delivered, the
    // wrapper mints exactly the GRAM in the batch or panics; it never wraps around.
    let seen = RefCell::new(Seen::default());
    run(256, prop::collection::vec(wrap_op(Just(None)), 1..8), |ops| {
        let mut world = World::new(false);
        for caller in 0..USERS - 1 {
            let deposit = Deposit::Min;
            world.step(&Op::Register { caller, account: None, deposit, registration_only: None });
        }
        for op in &ops {
            world.step(op);
        }
        for (path, n) in world.seen.0 {
            *seen.borrow_mut().0.entry(path).or_default() += n;
        }
    });
    seen.into_inner().assert_reached(&["oversized wrap rejected", "wrap minted above u64::MAX"]);
}
