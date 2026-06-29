use std::fmt;

use super::{
    error::{ExprError, ExprErrorKind, Span},
    Value,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}

impl Expr {
    fn new(kind: ExprKind, span: Span) -> Self {
        Self { kind, span }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExprKind {
    Literal(Value),
    Decimal(DecimalLiteral),
    Identifier(Vec<String>),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Call {
        name: String,
        args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecimalLiteral {
    pub mantissa: u128,
    pub scale: u32,
}

impl DecimalLiteral {
    pub fn denominator(&self) -> Option<u128> {
        10_u128.checked_pow(self.scale)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Not,
    Neg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Eq,
    NotEq,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
}

pub fn parse(source: &str) -> Result<Expr, ExprError> {
    let tokens = lex(source)?;
    if tokens.is_empty() {
        return Err(ExprError::new(Span::at(0), ExprErrorKind::EmptyExpression));
    }

    let mut parser = Parser { tokens, index: 0 };
    let expr = parser.parse_expr()?;
    if let Some(token) = parser.peek() {
        return Err(ExprError::new(
            token.span,
            ExprErrorKind::TrailingToken {
                found: token.kind.display().to_string(),
            },
        ));
    }
    Ok(expr)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    kind: TokenKind,
    span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Number(String),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    EqEq,
    NotEq,
    Lt,
    Lte,
    Gt,
    Gte,
    AndAnd,
    OrOr,
    Bang,
    LParen,
    RParen,
    Comma,
    Dot,
}

impl TokenKind {
    fn display(&self) -> &str {
        match self {
            Self::Number(_) => "number",
            Self::Ident(_) => "identifier",
            Self::Plus => "+",
            Self::Minus => "-",
            Self::Star => "*",
            Self::Slash => "/",
            Self::EqEq => "==",
            Self::NotEq => "!=",
            Self::Lt => "<",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::AndAnd => "&&",
            Self::OrOr => "||",
            Self::Bang => "!",
            Self::LParen => "(",
            Self::RParen => ")",
            Self::Comma => ",",
            Self::Dot => ".",
        }
    }
}

fn lex(source: &str) -> Result<Vec<Token>, ExprError> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }

        let start = i;
        if b.is_ascii_digit() {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len()
                && bytes[i] == b'.'
                && matches!(bytes.get(i + 1), Some(next) if next.is_ascii_digit())
            {
                i += 1;
                if i == bytes.len() || !bytes[i].is_ascii_digit() {
                    let end = i;
                    return Err(ExprError::new(
                        Span::new(start, end),
                        ExprErrorKind::InvalidNumber {
                            literal: source[start..end].to_string(),
                            reason: "decimal point must be followed by at least one digit".into(),
                        },
                    ));
                }
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            tokens.push(Token {
                kind: TokenKind::Number(source[start..i].to_string()),
                span: Span::new(start, i),
            });
            continue;
        }

        if is_ident_start(b) {
            i += 1;
            while i < bytes.len() && is_ident_continue(bytes[i]) {
                i += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Ident(source[start..i].to_string()),
                span: Span::new(start, i),
            });
            continue;
        }

        let kind = match b {
            b'+' => {
                i += 1;
                TokenKind::Plus
            }
            b'-' => {
                i += 1;
                TokenKind::Minus
            }
            b'*' => {
                i += 1;
                TokenKind::Star
            }
            b'/' => {
                i += 1;
                TokenKind::Slash
            }
            b'!' if matches!(bytes.get(i + 1), Some(b'=')) => {
                i += 2;
                TokenKind::NotEq
            }
            b'!' => {
                i += 1;
                TokenKind::Bang
            }
            b'=' if matches!(bytes.get(i + 1), Some(b'=')) => {
                i += 2;
                TokenKind::EqEq
            }
            b'=' => {
                return Err(ExprError::new(
                    Span::new(start, start + 1),
                    ExprErrorKind::UnexpectedToken {
                        expected: "`==` for equality".into(),
                        found: "=".into(),
                    },
                ));
            }
            b'<' if matches!(bytes.get(i + 1), Some(b'=')) => {
                i += 2;
                TokenKind::Lte
            }
            b'<' => {
                i += 1;
                TokenKind::Lt
            }
            b'>' if matches!(bytes.get(i + 1), Some(b'=')) => {
                i += 2;
                TokenKind::Gte
            }
            b'>' => {
                i += 1;
                TokenKind::Gt
            }
            b'&' if matches!(bytes.get(i + 1), Some(b'&')) => {
                i += 2;
                TokenKind::AndAnd
            }
            b'&' => {
                return Err(ExprError::new(
                    Span::new(start, start + 1),
                    ExprErrorKind::UnexpectedToken {
                        expected: "`&&` for logical and".into(),
                        found: "&".into(),
                    },
                ));
            }
            b'|' if matches!(bytes.get(i + 1), Some(b'|')) => {
                i += 2;
                TokenKind::OrOr
            }
            b'|' => {
                return Err(ExprError::new(
                    Span::new(start, start + 1),
                    ExprErrorKind::UnexpectedToken {
                        expected: "`||` for logical or".into(),
                        found: "|".into(),
                    },
                ));
            }
            b'(' => {
                i += 1;
                TokenKind::LParen
            }
            b')' => {
                i += 1;
                TokenKind::RParen
            }
            b',' => {
                i += 1;
                TokenKind::Comma
            }
            b'.' => {
                i += 1;
                TokenKind::Dot
            }
            _ => {
                let ch = source[start..].chars().next().expect("start is in bounds");
                return Err(ExprError::new(
                    Span::new(start, start + ch.len_utf8()),
                    ExprErrorKind::InvalidChar { ch },
                ));
            }
        };
        tokens.push(Token {
            kind,
            span: Span::new(start, i),
        });
    }
    Ok(tokens)
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.index)
    }

    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.index).cloned();
        if token.is_some() {
            self.index += 1;
        }
        token
    }

    fn parse_expr(&mut self) -> Result<Expr, ExprError> {
        self.parse_or()
    }

    fn parse_or(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_and()?;
        while self.matches(&TokenKind::OrOr) {
            let op_span = self.previous_span();
            let right = self.parse_and()?;
            let span = Span::new(expr.span.start, right.span.end);
            expr = Expr::new(
                ExprKind::Binary {
                    op: BinaryOp::Or,
                    left: Box::new(expr),
                    right: Box::new(right),
                },
                Span::new(span.start, span.end.max(op_span.end)),
            );
        }
        Ok(expr)
    }

    fn parse_and(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_equality()?;
        while self.matches(&TokenKind::AndAnd) {
            let right = self.parse_equality()?;
            let span = Span::new(expr.span.start, right.span.end);
            expr = Expr::new(
                ExprKind::Binary {
                    op: BinaryOp::And,
                    left: Box::new(expr),
                    right: Box::new(right),
                },
                span,
            );
        }
        Ok(expr)
    }

    fn parse_equality(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_comparison()?;
        loop {
            let op = if self.matches(&TokenKind::EqEq) {
                BinaryOp::Eq
            } else if self.matches(&TokenKind::NotEq) {
                BinaryOp::NotEq
            } else {
                break;
            };
            let right = self.parse_comparison()?;
            let span = Span::new(expr.span.start, right.span.end);
            expr = Expr::new(
                ExprKind::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(right),
                },
                span,
            );
        }
        Ok(expr)
    }

    fn parse_comparison(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_add()?;
        loop {
            let op = if self.matches(&TokenKind::Lt) {
                BinaryOp::Lt
            } else if self.matches(&TokenKind::Lte) {
                BinaryOp::Lte
            } else if self.matches(&TokenKind::Gt) {
                BinaryOp::Gt
            } else if self.matches(&TokenKind::Gte) {
                BinaryOp::Gte
            } else {
                break;
            };
            let right = self.parse_add()?;
            let span = Span::new(expr.span.start, right.span.end);
            expr = Expr::new(
                ExprKind::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(right),
                },
                span,
            );
        }
        Ok(expr)
    }

    fn parse_add(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_mul()?;
        loop {
            let op = if self.matches(&TokenKind::Plus) {
                BinaryOp::Add
            } else if self.matches(&TokenKind::Minus) {
                BinaryOp::Sub
            } else {
                break;
            };
            let right = self.parse_mul()?;
            let span = Span::new(expr.span.start, right.span.end);
            expr = Expr::new(
                ExprKind::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(right),
                },
                span,
            );
        }
        Ok(expr)
    }

    fn parse_mul(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.parse_unary()?;
        loop {
            let op = if self.matches(&TokenKind::Star) {
                BinaryOp::Mul
            } else if self.matches(&TokenKind::Slash) {
                BinaryOp::Div
            } else {
                break;
            };
            let right = self.parse_unary()?;
            let span = Span::new(expr.span.start, right.span.end);
            expr = Expr::new(
                ExprKind::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(right),
                },
                span,
            );
        }
        Ok(expr)
    }

    fn parse_unary(&mut self) -> Result<Expr, ExprError> {
        if self.matches(&TokenKind::Bang) {
            let span_start = self.previous_span().start;
            let expr = self.parse_unary()?;
            return Ok(Expr::new(
                ExprKind::Unary {
                    op: UnaryOp::Not,
                    expr: Box::new(expr.clone()),
                },
                Span::new(span_start, expr.span.end),
            ));
        }
        if self.matches(&TokenKind::Minus) {
            let span_start = self.previous_span().start;
            let expr = self.parse_unary()?;
            return Ok(Expr::new(
                ExprKind::Unary {
                    op: UnaryOp::Neg,
                    expr: Box::new(expr.clone()),
                },
                Span::new(span_start, expr.span.end),
            ));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, ExprError> {
        let token = self.next().ok_or_else(|| {
            ExprError::new(
                Span::at(self.tokens.last().map(|t| t.span.end).unwrap_or(0)),
                ExprErrorKind::UnexpectedEof {
                    expected: "number, bool, identifier, helper call, or `(`".into(),
                },
            )
        })?;

        match token.kind {
            TokenKind::Number(literal) => {
                let kind = parse_number(&literal, token.span)?;
                Ok(Expr::new(kind, token.span))
            }
            TokenKind::Ident(name) => {
                if self.matches(&TokenKind::LParen) {
                    return self.parse_call(name, token.span.start);
                }
                if name == "true" {
                    return Ok(Expr::new(ExprKind::Literal(Value::Bool(true)), token.span));
                }
                if name == "false" {
                    return Ok(Expr::new(ExprKind::Literal(Value::Bool(false)), token.span));
                }
                let mut path = vec![name];
                let mut end = token.span.end;
                while self.matches(&TokenKind::Dot) {
                    let ident = self.next().ok_or_else(|| {
                        ExprError::new(
                            Span::at(self.previous_span().end),
                            ExprErrorKind::UnexpectedEof {
                                expected: "identifier after `.`".into(),
                            },
                        )
                    })?;
                    match ident.kind {
                        TokenKind::Ident(segment) => {
                            end = ident.span.end;
                            path.push(segment);
                        }
                        TokenKind::Number(segment)
                            if segment.bytes().all(|byte| byte.is_ascii_digit()) =>
                        {
                            end = ident.span.end;
                            path.push(segment);
                        }
                        found => {
                            return Err(ExprError::new(
                                ident.span,
                                ExprErrorKind::UnexpectedToken {
                                    expected: "identifier after `.`".into(),
                                    found: found.display().to_string(),
                                },
                            ));
                        }
                    }
                }
                Ok(Expr::new(
                    ExprKind::Identifier(path),
                    Span::new(token.span.start, end),
                ))
            }
            TokenKind::LParen => {
                let expr = self.parse_expr()?;
                let end = self.expect(&TokenKind::RParen, "`)` after expression")?;
                Ok(Expr::new(
                    expr.kind,
                    Span::new(token.span.start, end.span.end),
                ))
            }
            found => Err(ExprError::new(
                token.span,
                ExprErrorKind::UnexpectedToken {
                    expected: "number, bool, identifier, helper call, or `(`".into(),
                    found: found.display().to_string(),
                },
            )),
        }
    }

    fn parse_call(&mut self, name: String, start: usize) -> Result<Expr, ExprError> {
        let mut args = Vec::new();
        if self.matches(&TokenKind::RParen) {
            let end = self.previous_span().end;
            return Ok(Expr::new(
                ExprKind::Call { name, args },
                Span::new(start, end),
            ));
        }
        loop {
            args.push(self.parse_expr()?);
            if self.matches(&TokenKind::Comma) {
                continue;
            }
            let end = self.expect(&TokenKind::RParen, "`,` or `)` after helper argument")?;
            return Ok(Expr::new(
                ExprKind::Call { name, args },
                Span::new(start, end.span.end),
            ));
        }
    }

    fn matches(&mut self, expected: &TokenKind) -> bool {
        if self
            .peek()
            .map(|token| token.kind.same_variant(expected))
            .unwrap_or(false)
        {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, expected: &TokenKind, label: &str) -> Result<Token, ExprError> {
        let token = self.next().ok_or_else(|| {
            ExprError::new(
                Span::at(self.tokens.last().map(|t| t.span.end).unwrap_or(0)),
                ExprErrorKind::UnexpectedEof {
                    expected: label.into(),
                },
            )
        })?;
        if token.kind.same_variant(expected) {
            Ok(token)
        } else {
            Err(ExprError::new(
                token.span,
                ExprErrorKind::UnexpectedToken {
                    expected: label.into(),
                    found: token.kind.display().to_string(),
                },
            ))
        }
    }

    fn previous_span(&self) -> Span {
        self.tokens
            .get(self.index.saturating_sub(1))
            .map(|token| token.span)
            .unwrap_or(Span::at(0))
    }
}

impl TokenKind {
    fn same_variant(&self, other: &Self) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
    }
}

fn parse_number(literal: &str, span: Span) -> Result<ExprKind, ExprError> {
    if let Some((whole, frac)) = literal.split_once('.') {
        if frac.len() > 18 {
            return Err(ExprError::new(
                span,
                ExprErrorKind::InvalidNumber {
                    literal: literal.to_string(),
                    reason: "decimal literals support at most 18 fractional digits".into(),
                },
            ));
        }
        let whole = whole.parse::<u128>().map_err(|err| {
            ExprError::new(
                span,
                ExprErrorKind::InvalidNumber {
                    literal: literal.to_string(),
                    reason: err.to_string(),
                },
            )
        })?;
        let scale = frac.len() as u32;
        let denominator = 10_u128.checked_pow(scale).ok_or_else(|| {
            ExprError::new(
                span,
                ExprErrorKind::InvalidNumber {
                    literal: literal.to_string(),
                    reason: "decimal scale overflows u128".into(),
                },
            )
        })?;
        let frac_value = if frac.is_empty() {
            0
        } else {
            frac.parse::<u128>().map_err(|err| {
                ExprError::new(
                    span,
                    ExprErrorKind::InvalidNumber {
                        literal: literal.to_string(),
                        reason: err.to_string(),
                    },
                )
            })?
        };
        let mantissa = whole
            .checked_mul(denominator)
            .and_then(|value| value.checked_add(frac_value))
            .ok_or_else(|| {
                ExprError::new(
                    span,
                    ExprErrorKind::InvalidNumber {
                        literal: literal.to_string(),
                        reason: "decimal mantissa overflows u128".into(),
                    },
                )
            })?;
        return Ok(ExprKind::Decimal(DecimalLiteral { mantissa, scale }));
    }

    literal
        .parse::<u128>()
        .map(|value| ExprKind::Literal(Value::U128(value)))
        .map_err(|err| {
            ExprError::new(
                span,
                ExprErrorKind::InvalidNumber {
                    literal: literal.to_string(),
                    reason: err.to_string(),
                },
            )
        })
}

impl fmt::Display for Expr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            ExprKind::Literal(Value::U128(value)) => write!(f, "{value}"),
            ExprKind::Literal(Value::I128(value)) => write!(f, "{value}"),
            ExprKind::Literal(Value::Bool(value)) => write!(f, "{value}"),
            ExprKind::Decimal(decimal) => fmt_decimal(decimal, f),
            ExprKind::Identifier(path) => write!(f, "{}", path.join(".")),
            ExprKind::Unary { op, expr } => {
                let op = match op {
                    UnaryOp::Not => "!",
                    UnaryOp::Neg => "-",
                };
                write!(f, "{op}{expr}")
            }
            ExprKind::Binary { op, left, right } => {
                write!(f, "({left} {} {right})", op.as_str())
            }
            ExprKind::Call { name, args } => {
                write!(f, "{name}(")?;
                for (idx, arg) in args.iter().enumerate() {
                    if idx > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{arg}")?;
                }
                write!(f, ")")
            }
        }
    }
}

fn fmt_decimal(decimal: &DecimalLiteral, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let Some(denominator) = decimal.denominator() else {
        return write!(f, "{}", decimal.mantissa);
    };
    if decimal.scale == 0 {
        return write!(f, "{}", decimal.mantissa);
    }
    let whole = decimal.mantissa / denominator;
    let frac = decimal.mantissa % denominator;
    write!(f, "{whole}.{frac:0width$}", width = decimal.scale as usize)
}

impl BinaryOp {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Add => "+",
            Self::Sub => "-",
            Self::Mul => "*",
            Self::Div => "/",
            Self::Eq => "==",
            Self::NotEq => "!=",
            Self::Lt => "<",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::And => "&&",
            Self::Or => "||",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dotted_and_simple_identifiers() {
        let expr = parse("reserve.collateral_amount + debt_value").unwrap();
        assert_eq!(expr.span, Span::new(0, 38));
        assert!(expr.to_string().contains("reserve.collateral_amount"));
        assert!(expr.to_string().contains("debt_value"));
    }

    #[test]
    fn parses_numeric_identifier_segments_after_dots() {
        let expr = parse("oracle.0.price + oracle.1.confidence").unwrap();
        assert_eq!(expr.to_string(), "(oracle.0.price + oracle.1.confidence)");
    }

    #[test]
    fn parses_nested_precedence() {
        let expr = parse("a + b * (c - 2) <= max(d, 10) && !flag").unwrap();
        assert_eq!(
            expr.to_string(),
            "(((a + (b * (c - 2))) <= max(d, 10)) && !flag)"
        );
    }

    #[test]
    fn parses_decimal_literals_as_decimal_ast_node() {
        let expr = parse("1.25").unwrap();
        assert_eq!(
            expr.kind,
            ExprKind::Decimal(DecimalLiteral {
                mantissa: 125,
                scale: 2
            })
        );
        assert_eq!(expr.to_string(), "1.25");
    }

    #[test]
    fn rejects_invalid_character_with_span() {
        let err = parse("a ^ b").unwrap_err();
        assert_eq!(err.span, Span::new(2, 3));
        assert!(matches!(err.kind, ExprErrorKind::InvalidChar { ch: '^' }));
    }

    #[test]
    fn rejects_trailing_token() {
        let err = parse("1 2").unwrap_err();
        assert_eq!(err.span, Span::new(2, 3));
        assert!(matches!(err.kind, ExprErrorKind::TrailingToken { .. }));
    }

    #[test]
    fn rejects_empty_expression() {
        let err = parse("   ").unwrap_err();
        assert_eq!(err.span, Span::at(0));
        assert!(matches!(err.kind, ExprErrorKind::EmptyExpression));
    }
}
