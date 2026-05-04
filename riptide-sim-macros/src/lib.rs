// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use proc_macro::TokenStream;
use quote::quote;
use syn::{
    parse::{Parse, ParseStream},
    parse_macro_input, Attribute, Error, Ident, ImplItem, ImplItemFn, ItemImpl, LitInt, Result,
    Token,
};

#[proc_macro_attribute]
pub fn riptide_sim(_attr: TokenStream, item: TokenStream) -> TokenStream {
    expand_riptide_sim(parse_macro_input!(item as ItemImpl))
        .unwrap_or_else(Error::into_compile_error)
        .into()
}

#[proc_macro_attribute]
pub fn init(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}

#[proc_macro_attribute]
pub fn flow(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}

#[proc_macro_attribute]
pub fn end(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}

fn expand_riptide_sim(mut item: ItemImpl) -> Result<proc_macro2::TokenStream> {
    let self_ty = item.self_ty.clone();
    let mut init_method: Option<Ident> = None;
    let mut end_method: Option<Ident> = None;
    let mut flows: Vec<(Ident, Option<u64>)> = Vec::new();

    for impl_item in &mut item.items {
        let ImplItem::Fn(method) = impl_item else {
            continue;
        };
        let markers = take_markers(method)?;
        if markers.init {
            if init_method.replace(method.sig.ident.clone()).is_some() {
                return Err(Error::new_spanned(
                    &method.sig.ident,
                    "duplicate #[init] method",
                ));
            }
        }
        if markers.end {
            if end_method.replace(method.sig.ident.clone()).is_some() {
                return Err(Error::new_spanned(
                    &method.sig.ident,
                    "duplicate #[end] method",
                ));
            }
        }
        if markers.flow {
            flows.push((method.sig.ident.clone(), markers.weight));
        }
    }

    let init_method = init_method
        .ok_or_else(|| Error::new_spanned(&item.impl_token, "missing #[init] method"))?;
    let end_method =
        end_method.ok_or_else(|| Error::new_spanned(&item.impl_token, "missing #[end] method"))?;
    if flows.is_empty() {
        return Err(Error::new_spanned(
            &item.impl_token,
            "missing #[flow] method",
        ));
    }
    let weights = resolve_weights(&flows)?;
    let flow_names = flows.iter().map(|(name, _)| name.to_string());
    let flow_idents = flows.iter().map(|(name, _)| name);
    let flow_indices = 0usize..flows.len();
    let (impl_generics, _, where_clause) = item.generics.split_for_impl();

    Ok(quote! {
        #item

        impl #impl_generics ::riptide_sim::RiptideSimulation for #self_ty #where_clause {
            fn world(&mut self) -> &mut ::riptide_sim::World {
                &mut self.world
            }

            fn __riptide_init(&mut self) -> ::riptide_sim::anyhow::Result<()> {
                ::riptide_sim::IntoSimResult::into_sim_result(self.#init_method())
            }

            fn __riptide_dispatch_flow(&mut self, idx: usize) -> ::riptide_sim::anyhow::Result<()> {
                match idx {
                    #(
                        #flow_indices => ::riptide_sim::IntoSimResult::into_sim_result(self.#flow_idents()),
                    )*
                    _ => ::riptide_sim::anyhow::bail!("flow index {idx} is out of bounds"),
                }
            }

            fn __riptide_end(&mut self) -> ::riptide_sim::anyhow::Result<()> {
                ::riptide_sim::IntoSimResult::into_sim_result(self.#end_method())
            }

            fn __riptide_flow_table() -> &'static [::riptide_sim::FlowSpec] {
                &[
                    #(
                        ::riptide_sim::FlowSpec { name: #flow_names, weight: #weights },
                    )*
                ]
            }
        }
    })
}

#[derive(Default)]
struct Markers {
    init: bool,
    flow: bool,
    end: bool,
    weight: Option<u64>,
}

fn take_markers(method: &mut ImplItemFn) -> Result<Markers> {
    let mut markers = Markers::default();
    let mut retained = Vec::new();
    for attr in std::mem::take(&mut method.attrs) {
        if attr.path().is_ident("init") {
            markers.init = true;
            continue;
        }
        if attr.path().is_ident("end") {
            markers.end = true;
            continue;
        }
        if attr.path().is_ident("flow") {
            markers.flow = true;
            markers.weight = parse_flow_weight(&attr)?;
            continue;
        }
        retained.push(attr);
    }
    method.attrs = retained;
    Ok(markers)
}

fn parse_flow_weight(attr: &Attribute) -> Result<Option<u64>> {
    if matches!(attr.meta, syn::Meta::Path(_)) {
        return Ok(None);
    }
    attr.parse_args::<FlowArgs>().map(|args| args.weight)
}

struct FlowArgs {
    weight: Option<u64>,
}

impl Parse for FlowArgs {
    fn parse(input: ParseStream<'_>) -> Result<Self> {
        if input.is_empty() {
            return Ok(Self { weight: None });
        }
        let key: Ident = input.parse()?;
        if key != "weight" {
            return Err(Error::new_spanned(key, "expected `weight = N`"));
        }
        input.parse::<Token![=]>()?;
        let value: LitInt = input.parse()?;
        Ok(Self {
            weight: Some(value.base10_parse()?),
        })
    }
}

fn resolve_weights(flows: &[(Ident, Option<u64>)]) -> Result<Vec<u64>> {
    let explicit_count = flows.iter().filter(|(_, weight)| weight.is_some()).count();
    if explicit_count > 0 {
        if explicit_count != flows.len() {
            return Err(Error::new(
                flows[0].0.span(),
                "do not mix weighted and unweighted #[flow] methods; either omit all weights or give every flow an explicit weight",
            ));
        }
        let weights = flows
            .iter()
            .map(|(_, weight)| weight.expect("explicit_count proved all weights are present"))
            .collect::<Vec<_>>();
        let sum: u64 = weights.iter().sum();
        if sum != 100 {
            let names = flows
                .iter()
                .map(|(ident, weight)| {
                    format!(
                        "{}={}",
                        ident,
                        weight.expect("explicit_count proved all weights are present")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(Error::new(
                flows[0].0.span(),
                format!("#[flow(weight = ...)] values must sum to 100; got {sum} ({names})"),
            ));
        }
        return Ok(weights);
    }

    let count = flows.len() as u64;
    let base = 100 / count;
    let remainder = 100 % count;
    Ok((0..flows.len() as u64)
        .map(|idx| base + u64::from(idx < remainder))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use quote::ToTokens;
    use syn::parse_quote;

    #[test]
    fn unweighted_flows_sum_to_one_hundred() {
        let flows: Vec<(Ident, Option<u64>)> = vec![
            (parse_quote!(a), None),
            (parse_quote!(b), None),
            (parse_quote!(c), None),
        ];

        assert_eq!(resolve_weights(&flows).unwrap(), vec![34, 33, 33]);
    }

    #[test]
    fn rejects_bad_explicit_weight_sum() {
        let flows: Vec<(Ident, Option<u64>)> =
            vec![(parse_quote!(a), Some(60)), (parse_quote!(b), Some(60))];

        assert!(resolve_weights(&flows).is_err());
    }

    #[test]
    fn rejects_mixed_explicit_and_implicit_weights() {
        let flows: Vec<(Ident, Option<u64>)> =
            vec![(parse_quote!(a), Some(50)), (parse_quote!(b), None)];

        assert!(resolve_weights(&flows).is_err());
    }

    #[test]
    fn expands_impl_with_markers() {
        let item: ItemImpl = parse_quote! {
            impl Simulation {
                #[init]
                fn setup(&mut self) {}

                #[flow(weight = 100)]
                fn step(&mut self) {}

                #[end]
                fn check(&mut self) {}
            }
        };

        let expanded = expand_riptide_sim(item)
            .unwrap()
            .to_token_stream()
            .to_string();
        assert!(expanded.contains("__riptide_dispatch_flow"));
        assert!(expanded.contains("FlowSpec"));
    }
}
