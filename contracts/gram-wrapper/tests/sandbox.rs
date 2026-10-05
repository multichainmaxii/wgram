//! End-to-end wrap/unwrap on a local NEAR sandbox against a NEP-245 mock of
//! HOT Bridge, plus a NEP-141 receiver mock for `ft_transfer_call`. After every step,
//! the wrapper's backing balance must equal its supply.

use near_sdk::json_types::U128;
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::json;
use tokio::sync::OnceCell;

const GRAM: &str = "1117_";
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

struct Env {
    mt: Contract,
    wrapper: Contract,
    /// A NEP-141 receiver that keeps part of each `ft_transfer_call` (see mock-ft-receiver).
    receiver: Contract,
    alice: Account,
    bob: Account,
}

struct Wasm {
    mt: Vec<u8>,
    wrapper: Vec<u8>,
    receiver: Vec<u8>,
}

/// Builds the contracts once per test binary instead of once per test.
async fn wasm() -> anyhow::Result<&'static Wasm> {
    static WASM: OnceCell<Wasm> = OnceCell::const_new();
    WASM.get_or_try_init(|| async {
        Ok(Wasm {
            mt: near_workspaces::compile_project("../mock-mt").await?,
            wrapper: near_workspaces::compile_project("./").await?,
            receiver: near_workspaces::compile_project("../mock-ft-receiver").await?,
        })
    })
    .await
}

async fn setup() -> anyhow::Result<Env> {
    let wasm = wasm().await?;
    let worker = near_workspaces::sandbox().await?;
    let mt = worker.dev_deploy(&wasm.mt).await?;
    mt.call("new").transact().await?.into_result()?;

    let wrapper = worker.dev_deploy(&wasm.wrapper).await?;
    wrapper
        .call("new")
        .args_json(json!({
            "mt_contract": mt.id(),
            "mt_token_id": GRAM,
            "metadata": { "spec": "ft-1.0.0", "name": "Wrapped GRAM", "symbol": "wGRAM", "decimals": 9 }
        }))
        .transact()
        .await?
        .into_result()?;

    let receiver = worker.dev_deploy(&wasm.receiver).await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    for account in [&alice, &bob] {
        mt.call("mint")
            .args_json(json!({ "account_id": account.id(), "token_id": GRAM, "amount": "1000" }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Env { mt, wrapper, receiver, alice, bob })
}

async fn register(env: &Env, account: &Account) -> anyhow::Result<()> {
    account
        .call(env.wrapper.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn wrap(env: &Env, account: &Account, amount: u128, msg: &str) -> anyhow::Result<()> {
    account
        .call(env.mt.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": env.wrapper.id(), "token_id": GRAM, "amount": amount.to_string(), "msg": msg
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn unwrap(env: &Env, account: &Account, amount: u128) -> anyhow::Result<()> {
    unwrap_to(env, account, amount, None).await
}

async fn unwrap_to(
    env: &Env,
    account: &Account,
    amount: u128,
    receiver_id: Option<&AccountId>,
) -> anyhow::Result<()> {
    account
        .call(env.wrapper.id(), "unwrap")
        .args_json(json!({ "amount": amount.to_string(), "receiver_id": receiver_id }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// `ft_transfer_call` to the mock receiver, which hands back `refund`. Returns the
/// amount the token reports as used.
async fn transfer_call(
    env: &Env,
    account: &Account,
    amount: u128,
    refund: u128,
) -> anyhow::Result<u128> {
    let used: U128 = account
        .call(env.wrapper.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.receiver.id(),
            "amount": amount.to_string(),
            "msg": refund.to_string(),
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .json()?;
    Ok(used.0)
}

async fn registered(env: &Env, account: &Account) -> anyhow::Result<bool> {
    let balance: Option<serde_json::Value> = env
        .wrapper
        .view("storage_balance_of")
        .args_json(json!({ "account_id": account.id() }))
        .await?
        .json()?;
    Ok(balance.is_some())
}

async fn wrapped(env: &Env, account: &Account) -> anyhow::Result<u128> {
    let b: U128 = env.wrapper.view("ft_balance_of").args_json(json!({ "account_id": account.id() })).await?.json()?;
    Ok(b.0)
}

async fn backing(env: &Env, account_id: &near_workspaces::AccountId) -> anyhow::Result<u128> {
    let b: U128 = env
        .mt
        .view("mt_balance_of")
        .args_json(json!({ "account_id": account_id, "token_id": GRAM }))
        .await?
        .json()?;
    Ok(b.0)
}

/// Wrapped supply must always equal the GRAM the wrapper holds.
async fn assert_fully_backed(env: &Env) -> anyhow::Result<()> {
    let supply: U128 = env.wrapper.view("ft_total_supply").await?.json()?;
    assert_eq!(supply.0, backing(env, env.wrapper.id()).await?, "supply != backing");
    Ok(())
}

#[tokio::test]
async fn wrap_and_unwrap_round_trip() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.alice).await?;

    wrap(&env, &env.alice, 400, "").await?;
    assert_eq!(wrapped(&env, &env.alice).await?, 400);
    assert_eq!(backing(&env, env.alice.id()).await?, 600);
    assert_fully_backed(&env).await?;

    unwrap(&env, &env.alice, 150).await?;
    assert_eq!(wrapped(&env, &env.alice).await?, 250);
    assert_eq!(backing(&env, env.alice.id()).await?, 750);
    assert_fully_backed(&env).await?;
    Ok(())
}

#[tokio::test]
async fn unregistered_sender_gets_everything_back() -> anyhow::Result<()> {
    let env = setup().await?;
    wrap(&env, &env.bob, 300, "").await?;
    assert_eq!(backing(&env, env.bob.id()).await?, 1000);
    assert_eq!(wrapped(&env, &env.bob).await?, 0);
    assert_fully_backed(&env).await?;
    Ok(())
}

#[tokio::test]
async fn wrap_to_another_account() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.bob).await?;
    let msg = json!({ "receiver_id": env.bob.id() }).to_string();
    wrap(&env, &env.alice, 200, &msg).await?;
    assert_eq!(wrapped(&env, &env.bob).await?, 200);
    assert_eq!(backing(&env, env.alice.id()).await?, 800);
    assert_fully_backed(&env).await?;
    Ok(())
}

#[tokio::test]
async fn failed_unwrap_restores_balance() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.alice).await?;
    wrap(&env, &env.alice, 400, "").await?;

    env.mt.call("set_fail_transfers").args_json(json!({ "fail": true })).transact().await?.into_result()?;
    // The outer call succeeds; the HOT transfer fails and the callback re-mints.
    unwrap(&env, &env.alice, 150).await?;
    assert_eq!(wrapped(&env, &env.alice).await?, 400);
    assert_eq!(backing(&env, env.alice.id()).await?, 600);
    assert_fully_backed(&env).await?;
    Ok(())
}

#[tokio::test]
async fn transfers_between_holders_stay_backed() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.alice).await?;
    register(&env, &env.bob).await?;
    wrap(&env, &env.alice, 500, "").await?;

    env.alice
        .call(env.wrapper.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": env.bob.id(), "amount": "120" }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(wrapped(&env, &env.bob).await?, 120);

    unwrap(&env, &env.bob, 120).await?;
    assert_eq!(backing(&env, env.bob.id()).await?, 1120);
    assert_fully_backed(&env).await?;
    Ok(())
}

#[tokio::test]
async fn transfer_call_refunds_what_the_receiver_hands_back() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.alice).await?;
    register(&env, env.receiver.as_account()).await?;
    wrap(&env, &env.alice, 500, "").await?;

    // The receiver keeps 70 of 100 and hands 30 back.
    assert_eq!(transfer_call(&env, &env.alice, 100, 30).await?, 70);
    assert_eq!(wrapped(&env, &env.alice).await?, 430);
    assert_eq!(wrapped(&env, env.receiver.as_account()).await?, 70);
    assert_fully_backed(&env).await?;

    // Claiming to return more than it was sent only returns what was sent; the 70 the
    // receiver already held stay put.
    assert_eq!(transfer_call(&env, &env.alice, 50, 1_000).await?, 0);
    assert_eq!(wrapped(&env, &env.alice).await?, 430);
    assert_eq!(wrapped(&env, env.receiver.as_account()).await?, 70);
    assert_fully_backed(&env).await?;
    Ok(())
}

#[tokio::test]
async fn sender_cannot_unregister_mid_transfer() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.alice).await?;
    register(&env, env.receiver.as_account()).await?;
    wrap(&env, &env.alice, 100, "").await?;

    // The drain loop from SECURITY.md L1: send everything, then unregister before the
    // receiver answers. The in-flight guard refuses the unregister, so the batch reverts.
    let outcome = env
        .alice
        .batch(env.wrapper.id())
        .call(
            Function::new("ft_transfer_call")
                .args_json(json!({
                    "receiver_id": env.receiver.id(), "amount": "100", "msg": "40"
                }))
                .deposit(ONE_YOCTO)
                .gas(Gas::from_tgas(100)),
        )
        .call(Function::new("storage_unregister").args_json(json!({})).deposit(ONE_YOCTO))
        .transact()
        .await?;
    let failure = format!("{:?}", outcome.into_result().expect_err("unregister mid-transfer"));
    assert!(failure.contains("in flight"), "{failure}");
    assert!(registered(&env, &env.alice).await?);
    assert_eq!(wrapped(&env, &env.alice).await?, 100);
    assert_eq!(wrapped(&env, env.receiver.as_account()).await?, 0);
    assert_fully_backed(&env).await?;

    // On its own the transfer settles normally, and once alice holds nothing and nothing
    // is in flight she can leave.
    assert_eq!(transfer_call(&env, &env.alice, 100, 40).await?, 60);
    assert_eq!(wrapped(&env, &env.alice).await?, 40);
    unwrap(&env, &env.alice, 40).await?;
    let left: bool = env
        .alice
        .call(env.wrapper.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .json()?;
    assert!(left);
    assert!(!registered(&env, &env.alice).await?);
    assert_fully_backed(&env).await?;
    Ok(())
}

#[tokio::test]
async fn unwrap_pays_another_receiver() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.alice).await?;
    wrap(&env, &env.alice, 400, "").await?;

    // Bob needs no wrapper registration to be paid in HOT GRAM.
    unwrap_to(&env, &env.alice, 150, Some(env.bob.id())).await?;
    assert_eq!(wrapped(&env, &env.alice).await?, 250);
    assert_eq!(backing(&env, env.alice.id()).await?, 600);
    assert_eq!(backing(&env, env.bob.id()).await?, 1150);
    assert_fully_backed(&env).await?;

    // A failed payout is re-minted to the owner, never to the receiver.
    env.mt
        .call("set_fail_transfers")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    unwrap_to(&env, &env.alice, 100, Some(env.bob.id())).await?;
    assert_eq!(wrapped(&env, &env.alice).await?, 250);
    assert_eq!(wrapped(&env, &env.bob).await?, 0);
    assert_eq!(backing(&env, env.bob.id()).await?, 1150);
    assert_fully_backed(&env).await?;
    Ok(())
}

#[tokio::test]
async fn owner_cannot_unregister_mid_unwrap() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.alice).await?;
    wrap(&env, &env.alice, 100, "").await?;
    env.mt
        .call("set_fail_transfers")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;

    // Unwrap everything and unregister in one transaction: refused, so the batch reverts.
    let outcome = env
        .alice
        .batch(env.wrapper.id())
        .call(
            Function::new("unwrap")
                .args_json(json!({ "amount": "100" }))
                .deposit(ONE_YOCTO)
                .gas(Gas::from_tgas(60)),
        )
        .call(Function::new("storage_unregister").args_json(json!({})).deposit(ONE_YOCTO))
        .transact()
        .await?;
    let failure = format!("{:?}", outcome.into_result().expect_err("unregister mid-unwrap"));
    assert!(failure.contains("in flight"), "{failure}");
    assert_eq!(wrapped(&env, &env.alice).await?, 100);
    assert_fully_backed(&env).await?;

    // A failed unwrap on its own comes back to alice, who is still registered. The
    // modest gas leaves on_unwrap close to its 10 Tgas floor.
    alice_unwrap_with_gas(&env, 100, 60).await?;
    assert!(registered(&env, &env.alice).await?);
    assert_eq!(wrapped(&env, &env.alice).await?, 100);
    assert_eq!(backing(&env, env.alice.id()).await?, 900);
    assert_fully_backed(&env).await?;
    Ok(())
}

async fn alice_unwrap_with_gas(env: &Env, amount: u128, tgas: u64) -> anyhow::Result<()> {
    env.alice
        .call(env.wrapper.id(), "unwrap")
        .args_json(json!({ "amount": amount.to_string() }))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn outsiders_cannot_mint_or_reach_callbacks() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.alice).await?;
    wrap(&env, &env.alice, 100, "").await?;

    // Another HOT token is sent straight back.
    env.mt
        .call("mint")
        .args_json(json!({ "account_id": env.alice.id(), "token_id": "1111_", "amount": "50" }))
        .transact()
        .await?
        .into_result()?;
    env.alice
        .call(env.mt.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": env.wrapper.id(), "token_id": "1111_", "amount": "50", "msg": ""
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let other: U128 = env
        .mt
        .view("mt_balance_of")
        .args_json(json!({ "account_id": env.alice.id(), "token_id": "1111_" }))
        .await?
        .json()?;
    assert_eq!(other.0, 50);

    // Calling the NEP-245 hook directly mints nothing.
    let refunds: Vec<U128> = env
        .alice
        .call(env.wrapper.id(), "mt_on_transfer")
        .args_json(json!({
            "sender_id": env.alice.id(), "previous_owner_ids": [env.alice.id()],
            "token_ids": [GRAM], "amounts": ["500"], "msg": ""
        }))
        .max_gas()
        .transact()
        .await?
        .json()?;
    assert_eq!(refunds, vec![U128(500)]);

    let metadata =
        json!({ "spec": "ft-1.0.0", "name": "Wrapped GRAM", "symbol": "wGRAM", "decimals": 9 });
    let attempts = [
        (
            "on_unwrap",
            json!({ "owner_id": env.alice.id(), "amount": "500" }),
            "Method on_unwrap is private",
        ),
        (
            "ft_resolve_transfer",
            json!({ "sender_id": env.bob.id(), "receiver_id": env.alice.id(), "amount": "100" }),
            "Method ft_resolve_transfer is private",
        ),
        (
            "new",
            json!({ "mt_contract": env.alice.id(), "mt_token_id": GRAM, "metadata": metadata }),
            "The contract has already been initialized",
        ),
    ];
    for (method, args, reason) in attempts {
        let outcome =
            env.alice.call(env.wrapper.id(), method).args_json(args).max_gas().transact().await?;
        let failure = format!("{:?}", outcome.into_result().expect_err(method));
        assert!(failure.contains(reason), "{method}: {failure}");
    }
    let outcome = env
        .alice
        .call(env.wrapper.id(), "storage_unregister")
        .args_json(json!({ "force": true }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    let failure = format!("{:?}", outcome.into_result().expect_err("force unregister"));
    assert!(failure.contains("positive balance"), "{failure}");

    assert_eq!(wrapped(&env, &env.alice).await?, 100);
    let mt_contract: AccountId = env.wrapper.view("mt_contract").await?.json()?;
    assert_eq!(&mt_contract, env.mt.id());
    assert_fully_backed(&env).await?;
    Ok(())
}

/// NEP-330 metadata is permanent once the keys are deleted, so check what gets baked in.
#[tokio::test]
async fn source_metadata_links_the_repo() -> anyhow::Result<()> {
    let env = setup().await?;
    let metadata: serde_json::Value = env.wrapper.view("contract_source_metadata").await?.json()?;
    let link = metadata["link"].as_str().unwrap_or_default();
    assert!(link.starts_with("https://github.com/multichainmaxii/wgram"), "{metadata}");
    let standards: Vec<&str> = metadata["standards"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["standard"].as_str())
        .collect();
    for standard in ["nep141", "nep145", "nep148", "nep330"] {
        assert!(standards.contains(&standard), "{standard} missing: {metadata}");
    }
    Ok(())
}
