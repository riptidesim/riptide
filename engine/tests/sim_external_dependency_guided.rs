use std::{fs, path::PathBuf, sync::Mutex};

use anyhow::{Context, Result};
use solana_account::Account;
use solana_sdk::pubkey::Pubkey;

use riptide_sim::{
    bootstrap::write_account_snapshot, riptide_sim, RunnerConfig, Service, SimulationRunner, World,
};

static MANIFEST_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

#[test]
fn sim_external_dependency_guided_manifest_account_service_mutation() -> Result<()> {
    let root = tempfile::tempdir()?;
    let sim_dir = root.path().join(".riptide/sim");
    let account_dir = sim_dir.join("fixtures/accounts");
    fs::create_dir_all(&account_dir)?;

    let dependency = dependency_account();
    write_account_snapshot(
        &dependency,
        &Account {
            lamports: 1_000_000,
            data: 42_u64.to_le_bytes().to_vec(),
            owner: dependency_owner(),
            ..Default::default()
        },
        account_dir.join("dependency-account.json"),
    )?;
    fs::write(
        sim_dir.join("Riptide.toml"),
        format!(
            r#"
[[sim.accounts]]
address = "{dependency}"
filename = "fixtures/accounts/dependency-account.json"

[sim.regression]
enabled = true
accounts = ["{dependency}"]
state_hashes = []

[sim.coverage]
enabled = false
"#
        ),
    )?;

    *MANIFEST_PATH.lock().unwrap() = Some(sim_dir.join("Riptide.toml"));
    let out_dir = root.path().join("artifacts/run-001");
    let result = SimulationRunner::<ExternalDependencySim>::new(RunnerConfig {
        flows_per_iteration: 3,
        out_dir: Some(out_dir.clone()),
        ..RunnerConfig::default()
    })
    .run();
    *MANIFEST_PATH.lock().unwrap() = None;
    result?;

    let artifact: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out_dir.join("guided-sim-run.json"))?)?;
    assert_eq!(artifact["status"], "passed");
    assert_eq!(artifact["totals"]["flows"], 3);
    assert_eq!(artifact["totals"]["service_ticks"], 3);
    assert_eq!(
        artifact["iterations"][0]["flow_counts"]["read_dependency_account"],
        3
    );
    assert!(
        artifact["iterations"][0]["regression"]["account_hashes"][dependency.to_string()]
            .as_str()
            .context("dependency regression hash")?
            .len()
            == 64
    );
    Ok(())
}

#[derive(Default)]
struct ExternalDependencySim {
    world: World,
    observed_values: Vec<u64>,
}

#[riptide_sim]
impl ExternalDependencySim {
    #[init]
    fn init(&mut self) -> Result<()> {
        let manifest_path = MANIFEST_PATH
            .lock()
            .unwrap()
            .clone()
            .context("test manifest path configured")?;
        let report = self.world.apply_manifest(&manifest_path)?;
        anyhow::ensure!(report.accounts_loaded == 1, "dependency account loaded");
        self.world.add_service(DependencyPriceService {
            account: dependency_account(),
            step: 1,
        });
        Ok(())
    }

    #[flow(weight = 100)]
    fn read_dependency_account(&mut self) -> Result<()> {
        self.observed_values
            .push(read_dependency_value(&self.world)?);
        Ok(())
    }

    #[end]
    fn end(&mut self) -> Result<()> {
        anyhow::ensure!(
            self.observed_values == vec![42, 43, 44],
            "service should mutate the dependency account between flows: {:?}",
            self.observed_values
        );
        anyhow::ensure!(
            read_dependency_value(&self.world)? == 45,
            "final service tick should be visible to regression hashing"
        );
        Ok(())
    }
}

struct DependencyPriceService {
    account: Pubkey,
    step: u64,
}

impl Service for DependencyPriceService {
    fn tick(&mut self, world: &mut World) {
        world
            .mutate_account(&self.account, |account| {
                let mut value = read_u64(&account.data);
                value = value.saturating_add(self.step);
                account.data = value.to_le_bytes().to_vec();
            })
            .expect("dependency account exists and is mutable");
    }
}

fn read_dependency_value(world: &World) -> Result<u64> {
    let account = world
        .get_account(&dependency_account())
        .context("dependency account loaded from Riptide.toml")?;
    Ok(read_u64(&account.data))
}

fn read_u64(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[..8].try_into().expect("dependency data is u64"))
}

fn dependency_account() -> Pubkey {
    Pubkey::new_from_array([42; 32])
}

fn dependency_owner() -> Pubkey {
    Pubkey::new_from_array([7; 32])
}
