//! `riptide-engine` binary entry point.
//!
//! End-to-end responsibilities:
//!   1. Parse CLI args (clap derive).
//!   2. Load run config + policies JSON.
//!   3. Connect to a local solana-test-validator.
//!   4. Deploy `lending_pool.so` and init oracle + pool.
//!   5. Seed one position account per agent.
//!   6. Construct a `ValidatorHarness` and call `run_simulation`.
//!   7. Write the `SimulationResult` JSON to `--output`.
//!
//! Progress/warnings go to stderr; nothing but the `SimulationResult` JSON
//! ever touches the output file. stdout is reserved.

use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::ExitCode,
    thread,
    time::{Duration, Instant},
};

use clap::Parser;
use riptide_engine::{
    harness::{
        lending::{LendingPoolConfig, LendingProgramClient},
        setup::{
            create_program_account, default_program_so_path, deploy_program, ORACLE_STATE_LEN,
            POOL_STATE_LEN, POSITION_STATE_LEN,
        },
    },
    safety::ensure_rpc_safe,
    scenario::{BaselineScenario, PriceShockScenario, Scenario},
    sim::{build_agent_personas, run_simulation, SimulationParams, ValidatorHarness},
    types::{Policy, RunConfig, SimulationResult},
};
use solana_client::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use solana_transaction::Transaction;

#[derive(Debug, Parser)]
#[command(
    name = "riptide-engine",
    version,
    about = "Riptide simulation engine",
    long_about = "Tick-based multi-agent lending-pool simulator. Runs against a live \
                  solana-test-validator; writes a SimulationResult JSON to --output."
)]
struct Cli {
    /// Path to the run configuration JSON file.
    #[arg(long, value_name = "FILE")]
    config: PathBuf,

    /// Path to the compiled policies JSON file (either one policy object or
    /// an array of policy objects).
    #[arg(long, value_name = "FILE")]
    policies: PathBuf,

    /// Path where the simulation result JSON should be written. Created (or
    /// truncated) on every run.
    #[arg(long, value_name = "FILE")]
    output: PathBuf,

    /// Payer keypair path. REQUIRED. The engine spends real SOL to fund
    /// admin/agent accounts and to deploy the program; it deliberately does
    /// not fall back to `~/.config/solana/id.json` so a malicious config
    /// cannot drain the operator's wallet. Use a disposable keypair created
    /// for this run.
    #[arg(long, value_name = "FILE", env = "RIPTIDE_PAYER")]
    payer: PathBuf,

    /// Skip program deployment (assume already deployed). Useful for local
    /// iteration, but normally the engine deploys fresh every run.
    #[arg(long, default_value_t = false)]
    skip_deploy: bool,

    /// Explicit opt-in to use a non-loopback validator URL. The CLI refuses
    /// to talk to anything other than localhost / 127.0.0.1 / [::1] without
    /// this flag, since `validator_url` comes from a JSON file and could be
    /// pointed at devnet/mainnet or an attacker RPC by a malicious PR.
    #[arg(long, default_value_t = false)]
    allow_nonlocal_rpc: bool,
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    let run_config: RunConfig = load_json(&cli.config)?;
    let policies: Vec<Policy> = load_policies(&cli.policies)?;
    if policies.is_empty() {
        anyhow::bail!("no policies found in {}", cli.policies.display());
    }

    eprintln!(
        "riptide-engine: loaded {} policies, agents={}, ticks={}, scenario={}",
        policies.len(),
        run_config.agents,
        run_config.ticks,
        run_config.scenario,
    );

    // --- Refuse non-loopback RPC URLs unless explicitly allowed. ---
    //
    // `validator_url` comes from a JSON file the engine doesn't own. If we
    // funded admin/agent accounts and deployed a program against an
    // arbitrary URL, a malicious config or PR could spend the operator's
    // SOL on devnet/mainnet or an attacker-controlled RPC. The flag is
    // there for the rare local-network case (e.g., a remote validator on
    // the operator's LAN with a disposable payer).
    ensure_rpc_safe(&run_config.validator_url, cli.allow_nonlocal_rpc)
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    // --- Fresh admin + agent keypairs (NOT derived from seed). ---
    //
    // The seed is for simulation RNG only. Deriving signing keys from a
    // seed that lives in run_config.json AND in SimulationResult would
    // leak private keys to anyone who can read the config or the output.
    // Since the engine deploys a fresh program and creates fresh accounts
    // every run, the admin/agent identities don't need to be reproducible
    // — only the simulation's price paths and policy decisions do.
    let admin = Keypair::new();
    eprintln!("admin pubkey: {}", admin.pubkey());

    // --- Payer (REQUIRED, pre-funded). ---
    let payer_path = cli.payer.clone();
    let payer = solana_sdk::signature::read_keypair_file(&payer_path)
        .map_err(|e| anyhow::anyhow!("read payer keypair {}: {e}", payer_path.display()))?;

    let rpc = RpcClient::new_with_commitment(
        run_config.validator_url.clone(),
        CommitmentConfig::confirmed(),
    );

    // --- Fund admin + agents with a modest amount so they can sign. ---
    let agents: Vec<Keypair> = (0..run_config.agents).map(|_| Keypair::new()).collect();
    fund_account(&rpc, &payer, &admin.pubkey(), 1_000_000_000)?;
    for agent in &agents {
        fund_account(&rpc, &payer, &agent.pubkey(), 1_000_000_000)?;
    }

    // --- Deploy program. ---
    let program_so = default_program_so_path();
    if !program_so.exists() {
        anyhow::bail!(
            "program .so missing at {} (run `cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml` first)",
            program_so.display()
        );
    }
    let program_id = if cli.skip_deploy {
        // Still need the program id; read the shipped keypair.
        let kp_path = program_so
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("deploy").join("lending_pool-keypair.json"))
            .ok_or_else(|| anyhow::anyhow!("cannot infer program keypair path"))?;
        let kp = solana_sdk::signature::read_keypair_file(&kp_path)
            .map_err(|e| anyhow::anyhow!("read program keypair: {e}"))?;
        kp.pubkey()
    } else {
        eprintln!("deploying lending_pool.so ...");
        let deployment = deploy_program(&program_so, &run_config.validator_url, &payer_path)?;
        wait_for_executable(&rpc, &deployment.program_id)?;
        deployment.program_id
    };
    eprintln!("program id: {program_id}");

    let client = LendingProgramClient::new(program_id);

    // --- Create oracle + pool accounts, initialize, then per-agent positions. ---
    let oracle = Keypair::new();
    let pool = Keypair::new();
    let position_keys: Vec<Keypair> = (0..run_config.agents).map(|_| Keypair::new()).collect();

    let rent_oracle = rpc
        .get_minimum_balance_for_rent_exemption(ORACLE_STATE_LEN)
        .map_err(|e| anyhow::anyhow!("rent oracle: {e}"))?;
    let rent_pool = rpc
        .get_minimum_balance_for_rent_exemption(POOL_STATE_LEN)
        .map_err(|e| anyhow::anyhow!("rent pool: {e}"))?;
    let rent_position = rpc
        .get_minimum_balance_for_rent_exemption(POSITION_STATE_LEN)
        .map_err(|e| anyhow::anyhow!("rent position: {e}"))?;

    let starting_price_f64: f64 = 100.0;
    let starting_price_u64: u64 = 100;

    // Pool risk params are tunable via env vars so the demo can exercise
    // a tighter risk regime without code changes. Defaults match the
    // original hardcoded conservative values (LTV 7000, threshold 8000,
    // bonus 500). See demo/README.md for the demo's chosen values.
    let ltv_bps: u16 = std::env::var("RIPTIDE_POOL_LTV_BPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7_000);
    let liquidation_threshold_bps: u16 = std::env::var("RIPTIDE_POOL_LIQ_THRESHOLD_BPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8_000);
    let liquidation_bonus_bps: u16 = std::env::var("RIPTIDE_POOL_LIQ_BONUS_BPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);
    let pool_config = LendingPoolConfig {
        ltv_bps,
        liquidation_threshold_bps,
        liquidation_bonus_bps,
        interest_bps: 250,
        deposit_limit: u64::MAX / 4,
        borrow_limit: u64::MAX / 4,
    };

    let init_ix = vec![
        create_program_account(
            &payer.pubkey(),
            &oracle.pubkey(),
            &program_id,
            rent_oracle,
            ORACLE_STATE_LEN,
        ),
        create_program_account(
            &payer.pubkey(),
            &pool.pubkey(),
            &program_id,
            rent_pool,
            POOL_STATE_LEN,
        ),
        client.initialize_oracle(admin.pubkey(), oracle.pubkey(), starting_price_u64, 0),
        client.initialize_pool(
            admin.pubkey(),
            pool.pubkey(),
            oracle.pubkey(),
            pool_config.clone(),
        ),
    ];
    send_tx(&rpc, &payer, init_ix, &[&payer, &admin, &oracle, &pool])?;

    // Create + own each agent's position account, in batches of 4 per tx.
    for (idx, pos_kp) in position_keys.iter().enumerate() {
        let ix = vec![create_program_account(
            &payer.pubkey(),
            &pos_kp.pubkey(),
            &program_id,
            rent_position,
            POSITION_STATE_LEN,
        )];
        send_tx(&rpc, &payer, ix, &[&payer, pos_kp])?;

        // Seed a starting deposit so agents have collateral to work with.
        // Tunable because the value is load-bearing: the borrow amounts the
        // runtime picks (~10–30k in practice) are trivially healthy against a
        // 10k×100 = 1M collateral value, so a price shock can never push
        // them underwater. The demo lowers this so debt/collateral ratios
        // land in a regime where the shipped price-shock scenario actually
        // triggers liquidations. See demo/README.md.
            // Default: 100 collateral units × $100/unit = $10,000 of seeded
        // collateral per agent. Paired with the $20k default starting
        // balance, initial cash is $10k and the agent can both deposit
        // more and open borrows large enough to be sensitive to a price
        // shock. Previously this was 10,000 units, which combined with
        // the fixed unit-pricing semantics would cost $1M per agent and
        // silently zero out initial cash.
        let seed_amount: u64 = std::env::var("RIPTIDE_SEED_COLLATERAL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(100);
        let deposit_ix = client.deposit(
            agents[idx].pubkey(),
            pool.pubkey(),
            pos_kp.pubkey(),
            seed_amount,
        );
        send_tx(&rpc, &payer, vec![deposit_ix], &[&payer, &agents[idx]])?;
    }

    // --- Build harness + scenario + params, then run. ---
    let position_pubkeys: Vec<Pubkey> = position_keys.iter().map(|k| k.pubkey()).collect();
    let agents_for_harness: Vec<Keypair> = agents.iter().map(|k| k.insecure_clone()).collect();
    let mut harness = ValidatorHarness::new(
        rpc,
        client,
        pool.pubkey(),
        oracle.pubkey(),
        admin,
        agents_for_harness,
        position_pubkeys,
    );

    let mut scenario: Box<dyn Scenario> = match run_config.scenario.as_str() {
        "baseline" => Box::new(BaselineScenario::new(starting_price_f64, 25)),
        "price-shock" | "price_shock" => {
            // Shock magnitude is tunable via RIPTIDE_PRICE_SHOCK_DROP (0..1).
            // Default 0.4 keeps the engine's own tests stable; the demo bumps
            // this to 0.7 so the on-chain liquidation threshold actually
            // trips for degen borrowers (see demo/README.md).
            let drop = std::env::var("RIPTIDE_PRICE_SHOCK_DROP")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|v| (0.0..1.0).contains(v))
                .unwrap_or(0.4);
            Box::new(PriceShockScenario::new(
                starting_price_f64,
                25,
                (run_config.ticks / 2).max(1),
                drop,
            ))
        }
        other => {
            eprintln!("warn: unknown scenario '{other}', falling back to baseline");
            Box::new(BaselineScenario::new(starting_price_f64, 25))
        }
    };

    // Honor `run_config.personas`: each entry must resolve to a policy in
    // the policies file. Round-robins over the requested persona list when
    // there are more agents than personas. Errors out up front if a persona
    // ID is missing — silent fallback would let the wrong policy mix run.
    let agent_personas = build_agent_personas(
        &run_config.personas,
        &policies,
        run_config.agents as usize,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    // Starting off-chain cash balance for each agent. Like seed_amount,
    // this is load-bearing: it bounds proportional sizing and fixed sizing
    // can consume it faster when reduced. The demo lowers both in tandem
    // so that debt/collateral ratios land in a regime where the shock
    // actually liquidates.
    let starting_balance: f64 = std::env::var("RIPTIDE_STARTING_BALANCE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_000.0);
    let params = SimulationParams {
        run_config: &run_config,
        policies,
        agent_personas,
        starting_balance,
        starting_price: starting_price_f64,
        simulation_boundaries: vec![
            "No slippage, fees, or MEV modeled.".into(),
            "Oracle prices are scenario-driven, not external feeds.".into(),
            "Agents funded via deterministic airdrop, not realistic onboarding.".into(),
        ],
    };

    eprintln!("running tick loop ...");
    let result = run_simulation(&mut harness, scenario.as_mut(), params)
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    write_result(&cli.output, &result)?;
    eprintln!("wrote {}", cli.output.display());
    Ok(())
}

fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let raw = fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let parsed = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))?;
    Ok(parsed)
}

/// Policies file may be either an array or a single object.
fn load_policies(path: &Path) -> anyhow::Result<Vec<Policy>> {
    let raw = fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))?;
    if value.is_array() {
        Ok(serde_json::from_value(value)?)
    } else {
        Ok(vec![serde_json::from_value(value)?])
    }
}

fn write_result(path: &Path, result: &SimulationResult) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| anyhow::anyhow!("mkdir {}: {e}", parent.display()))?;
        }
    }
    let serialized = serde_json::to_string_pretty(result)?;
    let mut file = File::create(path)
        .map_err(|e| anyhow::anyhow!("create {}: {e}", path.display()))?;
    file.write_all(serialized.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

fn send_tx(
    rpc: &RpcClient,
    payer: &Keypair,
    instructions: Vec<Instruction>,
    signers: &[&Keypair],
) -> anyhow::Result<()> {
    let blockhash = rpc
        .get_latest_blockhash()
        .map_err(|e| anyhow::anyhow!("blockhash: {e}"))?;
    let mut all_signers: Vec<&Keypair> = Vec::with_capacity(signers.len());
    let mut seen: Vec<Pubkey> = Vec::new();
    for signer in signers {
        if !seen.contains(&signer.pubkey()) {
            seen.push(signer.pubkey());
            all_signers.push(*signer);
        }
    }
    let tx = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        &all_signers,
        blockhash,
    );
    rpc.send_and_confirm_transaction(&tx)
        .map_err(|e| anyhow::anyhow!("send_and_confirm: {e}"))?;
    Ok(())
}

fn fund_account(
    rpc: &RpcClient,
    payer: &Keypair,
    recipient: &Pubkey,
    lamports: u64,
) -> anyhow::Result<()> {
    let ix = solana_system_interface::instruction::transfer(&payer.pubkey(), recipient, lamports);
    send_tx(rpc, payer, vec![ix], &[payer])
}

fn wait_for_executable(rpc: &RpcClient, program_id: &Pubkey) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match rpc.get_account(program_id) {
            Ok(account) if account.executable => break,
            _ if Instant::now() < deadline => thread::sleep(Duration::from_millis(500)),
            other => anyhow::bail!("program {program_id} never became executable: {other:?}"),
        }
    }
    let start_slot = rpc.get_slot().unwrap_or(0);
    let slot_deadline = Instant::now() + Duration::from_secs(15);
    while rpc.get_slot().unwrap_or(start_slot) < start_slot + 2 {
        if Instant::now() >= slot_deadline {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

