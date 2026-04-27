use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProgramErrorEntry {
    pub code: u32,
    pub label: String,
    pub interpretation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodedProgramError {
    pub code: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interpretation: Option<String>,
}

impl ProgramErrorEntry {
    pub fn decode(&self) -> DecodedProgramError {
        DecodedProgramError {
            code: self.code,
            label: Some(self.label.clone()),
            interpretation: Some(self.interpretation.clone()),
        }
    }
}

pub fn decode_program_error(
    registry: &[ProgramErrorEntry],
    detail: Option<&str>,
) -> Option<DecodedProgramError> {
    let code = extract_custom_code(detail?)?;
    Some(
        registry
            .iter()
            .find(|entry| entry.code == code)
            .map(ProgramErrorEntry::decode)
            .unwrap_or(DecodedProgramError {
                code,
                label: None,
                interpretation: None,
            }),
    )
}

pub fn validate_error_entries(
    entries: &[ProgramErrorEntry],
) -> Result<(), ErrorRegistryValidation> {
    let mut codes = BTreeSet::new();
    let mut labels = BTreeSet::new();
    for (idx, entry) in entries.iter().enumerate() {
        if !codes.insert(entry.code) {
            return Err(ErrorRegistryValidation::DuplicateCode {
                index: idx,
                code: entry.code,
            });
        }
        if !is_snake_case_label(&entry.label) {
            return Err(ErrorRegistryValidation::MalformedLabel {
                index: idx,
                label: entry.label.clone(),
            });
        }
        if !labels.insert(entry.label.as_str()) {
            return Err(ErrorRegistryValidation::DuplicateLabel {
                index: idx,
                label: entry.label.clone(),
            });
        }
        if entry.interpretation.trim().is_empty()
            || entry
                .interpretation
                .chars()
                .any(|ch| ch == '\n' || ch == '\r')
        {
            return Err(ErrorRegistryValidation::MalformedInterpretation { index: idx });
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorRegistryValidation {
    DuplicateCode { index: usize, code: u32 },
    DuplicateLabel { index: usize, label: String },
    MalformedLabel { index: usize, label: String },
    MalformedInterpretation { index: usize },
}

fn is_snake_case_label(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

fn extract_custom_code(detail: &str) -> Option<u32> {
    let marker = "Custom(";
    let start = detail.find(marker)? + marker.len();
    let rest = detail.get(start..)?;
    let end = rest.find(')')?;
    rest.get(..end)?.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_registered_custom_code() {
        let entries = vec![ProgramErrorEntry {
            code: 8,
            label: "insufficient_collateral".into(),
            interpretation: "Borrow or withdraw exceeded collateral constraints.".into(),
        }];
        let decoded =
            decode_program_error(&entries, Some("InstructionError(0, Custom(8))")).unwrap();
        assert_eq!(decoded.code, 8);
        assert_eq!(decoded.label.as_deref(), Some("insufficient_collateral"));
    }

    #[test]
    fn falls_back_to_code_only_for_unknown_custom_code() {
        let decoded = decode_program_error(&[], Some("InstructionError(0, Custom(42))")).unwrap();
        assert_eq!(decoded.code, 42);
        assert_eq!(decoded.label, None);
        assert_eq!(decoded.interpretation, None);
    }
}
