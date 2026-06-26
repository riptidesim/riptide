use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub const fn at(offset: usize) -> Self {
        Self {
            start: offset,
            end: offset,
        }
    }
}

impl fmt::Display for Span {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}..{}", self.start, self.end)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExprErrorKind {
    EmptyExpression,
    InvalidChar { ch: char },
    InvalidNumber { literal: String, reason: String },
    UnexpectedEof { expected: String },
    UnexpectedToken { expected: String, found: String },
    TrailingToken { found: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExprError {
    pub span: Span,
    pub kind: ExprErrorKind,
}

impl ExprError {
    pub fn new(span: Span, kind: ExprErrorKind) -> Self {
        Self { span, kind }
    }
}

impl fmt::Display for ExprError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            ExprErrorKind::EmptyExpression => {
                write!(f, "empty expression at byte span {}", self.span)
            }
            ExprErrorKind::InvalidChar { ch } => write!(
                f,
                "invalid character `{}` at byte span {}",
                ch.escape_debug(),
                self.span
            ),
            ExprErrorKind::InvalidNumber { literal, reason } => write!(
                f,
                "invalid numeric literal `{literal}` at byte span {}: {reason}",
                self.span
            ),
            ExprErrorKind::UnexpectedEof { expected } => write!(
                f,
                "unexpected end of expression at byte span {}; expected {expected}",
                self.span
            ),
            ExprErrorKind::UnexpectedToken { expected, found } => write!(
                f,
                "unexpected token `{found}` at byte span {}; expected {expected}",
                self.span
            ),
            ExprErrorKind::TrailingToken { found } => {
                write!(f, "trailing token `{found}` at byte span {}", self.span)
            }
        }
    }
}

impl std::error::Error for ExprError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvalError {
    DivideByZero {
        span: Span,
    },
    IntegerOverflow {
        span: Span,
    },
    MissingField {
        path: String,
        span: Span,
    },
    TypeMismatch {
        expected: String,
        found: String,
        span: Span,
    },
    UnknownIdentifier {
        name: String,
        span: Span,
    },
    UnknownHelper {
        name: String,
        span: Span,
    },
    Arity {
        expected: usize,
        found: usize,
        span: Span,
    },
}

impl EvalError {
    pub fn span(&self) -> Span {
        match self {
            Self::DivideByZero { span }
            | Self::IntegerOverflow { span }
            | Self::MissingField { span, .. }
            | Self::TypeMismatch { span, .. }
            | Self::UnknownIdentifier { span, .. }
            | Self::UnknownHelper { span, .. }
            | Self::Arity { span, .. } => *span,
        }
    }
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DivideByZero { span } => write!(f, "divide by zero at byte span {span}"),
            Self::IntegerOverflow { span } => {
                write!(f, "integer overflow at byte span {span}")
            }
            Self::MissingField { path, span } => {
                write!(f, "missing field `{path}` at byte span {span}")
            }
            Self::TypeMismatch {
                expected,
                found,
                span,
            } => write!(
                f,
                "type mismatch at byte span {span}: expected {expected}, found {found}"
            ),
            Self::UnknownIdentifier { name, span } => {
                write!(f, "unknown identifier `{name}` at byte span {span}")
            }
            Self::UnknownHelper { name, span } => {
                write!(f, "unknown helper `{name}` at byte span {span}")
            }
            Self::Arity {
                expected,
                found,
                span,
            } => write!(
                f,
                "helper arity mismatch at byte span {span}: expected {expected}, found {found}"
            ),
        }
    }
}

impl std::error::Error for EvalError {}
