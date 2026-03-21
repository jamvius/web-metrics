// Replicates the Lighthouse Performance Score (0-100).
// Each metric is converted to a 0-1 score via a log-normal CDF fitted to two
// control points: p10 (score = 0.9) and median (score = 0.5). The overall
// score is a weighted sum, matching Lighthouse 10+ weights.

const WEIGHTS = {
  fcp: 0.10,
  si:  0.10,
  lcp: 0.25,
  tbt: 0.30,
  cls: 0.25,
};

// Control points derived from Chrome UX Report field data.
// p10  → score 0.9 (Good threshold)
// median → score 0.5
const METRIC_PARAMS = {
  fcp:  { median: 3000,  p10: 1800  },
  si:   { median: 5800,  p10: 3387  },
  lcp:  { median: 4000,  p10: 2500  },
  tbt:  { median: 600,   p10: 200   },
  cls:  { median: 0.25,  p10: 0.1   },
};

// Standard normal CDF via Horner approximation (Abramowitz & Stegun 7.1.26).
// Max error: ~1.5e-7.
function normalCDF(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
    Math.exp(-x * x);
  return z >= 0 ? 1 - erfc / 2 : erfc / 2;
}

// Score a single metric using a log-normal distribution.
// σ is chosen so that score(p10) = 0.9 and score(median) = 0.5.
// Φ⁻¹(0.9) ≈ 1.2816
function scoreMetric(value, { median, p10 }) {
  if (value === null || value === undefined) return null;
  const sigma = Math.log(median / p10) / 1.2816;
  const z = Math.log(median / Math.max(value, 1e-10)) / sigma;
  return Math.max(0, Math.min(1, normalCDF(z)));
}

// Returns the Lighthouse performance score (0-100).
// Missing metrics are excluded and remaining weights are renormalized.
export function computeLighthouseScore(vitals) {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [metric, weight] of Object.entries(WEIGHTS)) {
    const s = scoreMetric(vitals[metric], METRIC_PARAMS[metric]);
    if (s === null) continue;
    weightedSum += s * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;
  return Math.round((weightedSum / totalWeight) * 100);
}

export function scoreLabel(score) {
  if (score === null) return 'N/A';
  if (score >= 90) return 'Good';
  if (score >= 50) return 'Needs improvement';
  return 'Poor';
}

export function scoreColor(score) {
  if (score === null) return '#999';
  if (score >= 90) return '#0cce6b';
  if (score >= 50) return '#ffa400';
  return '#ff4e42';
}
