import type { SentryEvent } from "../types.ts";

const SQRT_2 = Math.sqrt(2);

// Gauss error function
function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return sign * y;
}

// Sigma function for CDF score calculation
export function calculateCdfSigma(p10: number, p50: number): number {
  return (
    Math.abs(Math.log(p10) - Math.log(p50)) / (SQRT_2 * 0.9061938024368232)
  );
}

// Calculates a log-normal CDF score based on a log-normal with a specific p10 and p50
export function calculateCdfScore(
  value: number,
  p10: number,
  p50: number,
): number {
  return (
    0.5 *
    (1.0 -
      erf(
        (Math.log(value) - Math.log(p50)) /
          (SQRT_2 * calculateCdfSigma(p50, p10)),
      ))
  );
}

interface ScoreComponent {
  measurement: string;
  weight: number;
  p10: number;
  p50: number;
  optional?: boolean;
}

interface Profile {
  name: string;
  scoreComponents: ScoreComponent[];
  condition?: {
    op: string;
    name: string;
    value: string | number;
  };
}

export interface PerformanceScoreConfig {
  profiles: Profile[];
}

// export function getPropertyByPath(obj: Record<string, any>, path: string): any {
//   const keys = path.split('.');
//   let result = obj;

//   for (const key of keys) {
//     if (result && result[key]) {
//       result = result[key];
//     } else {
//       return undefined;
//     }
//   }

//   return result;
// }

// export function matchCondition(condition: { op: string; name: string; value: string | number }, event: SentryEvent): boolean {
//   const { op, name, value } = condition;

//   if (op === 'eq') {
//     const eventValue = getPropertyByPath({ event }, name);
//     return eventValue === value;
//   }

//   return false;
// }

export function normalizePerformanceScore(
  event: SentryEvent,
  performanceScore: PerformanceScoreConfig | undefined,
): void {
  if (!performanceScore || event.type === "profile_chunk") {
    return;
  }

  for (const profile of performanceScore.profiles) {
    // TODO: To check a matching condition as done in relay. Skipped right now because Browser type is not coming in Event data
    // const condition = profile.condition;
    // if (condition && !matchCondition(condition, event)) {
    //   continue;
    // }

    const measurements = event.measurements;

    if (measurements) {
      let shouldAddTotal = false;

      // TODO: To calculate performance score if all required metric fields are present in event measurement data.
      // if (
      //   profile.scoreComponents.some(c => {
      //     return (
      //       !Object.prototype.hasOwnProperty.call(measurements, c.measurement) &&
      //       Math.abs(c.weight) >= Number.EPSILON &&
      //       !c.optional
      //     );
      //   })
      // ) {
      //   break;
      // }

      let scoreTotal = 0.0;
      let weightTotal = 0.0;

      for (const component of profile.scoreComponents) {
        if (
          component.optional &&
          !Object.prototype.hasOwnProperty.call(
            measurements,
            component.measurement,
          )
        ) {
          continue;
        }

        weightTotal += component.weight;
      }

      if (Math.abs(weightTotal) < Number.EPSILON) {
        break;
      }

      for (const component of profile.scoreComponents) {
        let normalizedComponentWeight = 0.0;

        if (
          Object.prototype.hasOwnProperty.call(
            measurements,
            component.measurement,
          )
        ) {
          normalizedComponentWeight = component.weight / weightTotal;
          const value = measurements[component.measurement].value;
          const cdf = calculateCdfScore(
            Math.max(0.0, value),
            component.p10,
            component.p50,
          );
          const componentScore = cdf * normalizedComponentWeight;
          scoreTotal += componentScore;
          shouldAddTotal = true;

          measurements[`score.${component.measurement}`] = {
            value: cdf,
            unit: "ratio",
          };
        } else {
          measurements[`score.${component.measurement}`] = {
            value: 0,
            unit: "ratio",
          };
        }

        measurements[`score.weight.${component.measurement}`] = {
          value: normalizedComponentWeight,
          unit: "ratio",
        };
      }

      if (
        shouldAddTotal &&
        !Object.prototype.hasOwnProperty.call(measurements, "score.total")
      ) {
        measurements["score.total"] = {
          value: scoreTotal,
          unit: "ratio",
        };
      }

      break;
    }
  }
}
