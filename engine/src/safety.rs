//! CLI safety helpers. The engine spends real SOL to fund admin/agent
//! accounts and to deploy a program; if `validator_url` ever points outside
//! a local validator, that becomes a wallet-draining footgun. These helpers
//! enforce a loopback-only default unless the operator explicitly opts in.

/// Extract just the hostname from an `http://host:port/...` style URL with
/// no third-party crates. Returns `None` if the URL is malformed in a way
/// that prevents host extraction, in which case the caller MUST treat it as
/// non-local.
pub fn extract_host(url: &str) -> Option<&str> {
    // Strip the scheme.
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    // Strip any "user[:pass]@" credential prefix.
    let after_creds = after_scheme.rsplit_once('@').map(|(_, rest)| rest).unwrap_or(after_scheme);
    // Take everything up to the first path/query/fragment delimiter.
    let host_port = after_creds
        .split(|c: char| c == '/' || c == '?' || c == '#')
        .next()?;
    if host_port.is_empty() {
        return None;
    }
    // IPv6 literals are wrapped in `[...]`, optionally followed by `:port`.
    if let Some(rest) = host_port.strip_prefix('[') {
        let close = rest.find(']')?;
        return Some(&rest[..close]);
    }
    // host:port — take everything up to the last `:`. (IPv4/hostname only.)
    Some(host_port.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_port))
}

/// `true` iff `host` matches the small allowlist of loopback names that we
/// trust to mean "local validator on this machine". Anything else (devnet,
/// testnet, mainnet, an attacker-controlled RPC) requires explicit opt-in.
pub fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Decide whether the engine is allowed to spend real SOL against this RPC.
/// Returns `Ok(())` if the URL is loopback OR if the operator passed
/// `--allow-nonlocal-rpc`. Otherwise returns a descriptive error so the
/// caller can `bail!`.
pub fn ensure_rpc_safe(url: &str, allow_nonlocal: bool) -> Result<(), String> {
    let host = extract_host(url)
        .ok_or_else(|| format!("could not extract host from validator_url '{url}'"))?;
    if is_loopback_host(host) {
        return Ok(());
    }
    if allow_nonlocal {
        return Ok(());
    }
    Err(format!(
        "refusing non-local validator_url '{url}' (host '{host}'); \
         pass --allow-nonlocal-rpc explicitly and only with a disposable payer"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_host_from_typical_local_url() {
        assert_eq!(extract_host("http://localhost:8899"), Some("localhost"));
        assert_eq!(extract_host("http://127.0.0.1:8899"), Some("127.0.0.1"));
        assert_eq!(extract_host("https://api.devnet.solana.com"), Some("api.devnet.solana.com"));
        assert_eq!(extract_host("http://[::1]:8899/foo"), Some("::1"));
        assert_eq!(extract_host("http://user:pw@evil.example/x"), Some("evil.example"));
    }

    #[test]
    fn loopback_classifier_rejects_public_hosts() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(!is_loopback_host("api.mainnet-beta.solana.com"));
        assert!(!is_loopback_host("api.devnet.solana.com"));
        assert!(!is_loopback_host("10.0.0.1"));
    }

    #[test]
    fn ensure_rpc_safe_allows_loopback_without_flag() {
        ensure_rpc_safe("http://localhost:8899", false).unwrap();
        ensure_rpc_safe("http://127.0.0.1:8899", false).unwrap();
    }

    #[test]
    fn ensure_rpc_safe_blocks_non_local_without_flag() {
        let err = ensure_rpc_safe("https://api.devnet.solana.com", false).unwrap_err();
        assert!(err.contains("refusing non-local"));
    }

    #[test]
    fn ensure_rpc_safe_allows_non_local_when_opted_in() {
        ensure_rpc_safe("https://api.devnet.solana.com", true).unwrap();
    }

    #[test]
    fn ensure_rpc_safe_rejects_unparseable_url() {
        let err = ensure_rpc_safe("", false).unwrap_err();
        assert!(err.contains("could not extract host"));
    }
}
