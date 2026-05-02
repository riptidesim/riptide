use rand::{rngs::StdRng, Rng};

use super::{OracleUpdate, Scenario};

#[derive(Debug, Clone)]
pub struct BaselineScenario {
    base_price: f64,
    noise_bps: u16,
}

impl BaselineScenario {
    pub fn new(base_price: f64, noise_bps: u16) -> Self {
        Self {
            base_price,
            noise_bps,
        }
    }
}

impl Scenario for BaselineScenario {
    fn update(&mut self, _tick: u32, rng: &mut StdRng) -> OracleUpdate {
        let noise = rng.random_range(-(self.noise_bps as f64)..=(self.noise_bps as f64)) / 10_000.0;
        OracleUpdate {
            price: self.base_price * (1.0 + noise),
            exponent: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PriceShockScenario {
    base: BaselineScenario,
    shock_tick: u32,
    drop_percent: f64,
    shocked: bool,
}

impl PriceShockScenario {
    pub fn new(base_price: f64, noise_bps: u16, shock_tick: u32, drop_percent: f64) -> Self {
        Self {
            base: BaselineScenario::new(base_price, noise_bps),
            shock_tick,
            drop_percent,
            shocked: false,
        }
    }
}

impl Scenario for PriceShockScenario {
    fn update(&mut self, tick: u32, rng: &mut StdRng) -> OracleUpdate {
        if !self.shocked && tick >= self.shock_tick {
            // Price shocks are persistent for the remainder of the run; baseline
            // noise continues to oscillate around the post-shock level.
            self.base.base_price *= 1.0 - self.drop_percent;
            self.shocked = true;
        }

        self.base.update(tick, rng)
    }
}

#[cfg(test)]
mod tests {
    use rand::{rngs::StdRng, SeedableRng};

    use super::*;

    #[test]
    fn baseline_stays_close_to_base_price() {
        let mut scenario = BaselineScenario::new(100.0, 50);
        let mut rng = StdRng::seed_from_u64(42);

        for tick in 0..10 {
            let update = scenario.update(tick, &mut rng);
            assert!(update.price > 99.4 && update.price < 100.6);
        }
    }

    #[test]
    fn price_shock_fires_at_expected_tick() {
        let mut scenario = PriceShockScenario::new(100.0, 0, 3, 0.4);
        let mut rng = StdRng::seed_from_u64(42);

        let before = scenario.update(2, &mut rng);
        let after = scenario.update(3, &mut rng);

        assert_eq!(before.price, 100.0);
        assert_eq!(after.price, 60.0);
    }
}
