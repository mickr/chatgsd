use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Expression {
    Neutral,
    Curious,
    Focused,
    Uncertain,
    Pleased,
    Concerned,
}

/// Expressive UI metadata, not a claim about feelings or task completion.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExpressionUpdate {
    pub expression: Expression,
    pub sentiment: f64,
    pub intensity: f64,
}

impl ExpressionUpdate {
    pub fn from_args(args: Value) -> Result<Self, String> {
        let update: Self = serde_json::from_value(args)
            .map_err(|error| format!("Invalid expression: {error}"))?;
        update.validate().map_err(str::to_owned)?;
        Ok(update)
    }

    fn validate(&self) -> Result<(), &'static str> {
        if !self.sentiment.is_finite() || !(-1.0..=1.0).contains(&self.sentiment) {
            return Err("sentiment must be a finite number from -1 to 1");
        }
        if !self.intensity.is_finite() || !(0.0..=1.0).contains(&self.intensity) {
            return Err("intensity must be a finite number from 0 to 1");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{Expression, ExpressionUpdate};
    use serde_json::json;

    #[test]
    fn accepts_every_expression_and_inclusive_numeric_bounds() {
        for expression in ["neutral", "curious", "focused", "uncertain", "pleased", "concerned"] {
            for (sentiment, intensity) in [(-1.0, 0.0), (0.0, 0.5), (1.0, 1.0)] {
                let update = ExpressionUpdate::from_args(json!({
                    "expression": expression,
                    "sentiment": sentiment,
                    "intensity": intensity,
                }))
                .unwrap();

                assert_eq!(update.sentiment, sentiment);
                assert_eq!(update.intensity, intensity);
            }
        }
    }

    #[test]
    fn rejects_unknown_missing_extra_and_wrongly_typed_fields() {
        for args in [
            json!({"expression":"happy","sentiment":0,"intensity":1}),
            json!({"expression":"neutral","intensity":1}),
            json!({"expression":"neutral","sentiment":0,"intensity":1,"done":true}),
            json!({"expression":"neutral","sentiment":"0","intensity":1}),
            json!({"expression":"neutral","sentiment":0,"intensity":null}),
        ] {
            assert!(ExpressionUpdate::from_args(args).is_err());
        }
    }

    #[test]
    fn rejects_out_of_range_and_non_finite_numbers() {
        for (sentiment, intensity) in [
            (-1.01, 0.5),
            (1.01, 0.5),
            (0.0, -0.01),
            (0.0, 1.01),
            (f64::NAN, 0.5),
            (f64::INFINITY, 0.5),
            (f64::NEG_INFINITY, 0.5),
            (0.0, f64::NAN),
            (0.0, f64::INFINITY),
            (0.0, f64::NEG_INFINITY),
        ] {
            let update = ExpressionUpdate {
                expression: Expression::Neutral,
                sentiment,
                intensity,
            };

            assert!(update.validate().is_err());
        }
    }
}
