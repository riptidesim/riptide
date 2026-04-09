use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Parser)]
#[command(
    name = "riptide-engine",
    version,
    about = "Riptide simulation engine",
    long_about = "Phase 1 scaffold for the Rust simulation engine."
)]
struct Cli {
    /// Path to the run configuration JSON file.
    #[arg(long, value_name = "FILE")]
    config: PathBuf,

    /// Path to the compiled policy JSON file.
    #[arg(long, value_name = "FILE")]
    policies: PathBuf,

    /// Path where the simulation result JSON should be written.
    #[arg(long, value_name = "FILE")]
    output: PathBuf,
}

fn main() {
    let cli = Cli::parse();

    eprintln!(
        "Phase 1 scaffold: config={}, policies={}, output={}",
        cli.config.display(),
        cli.policies.display(),
        cli.output.display()
    );
}
