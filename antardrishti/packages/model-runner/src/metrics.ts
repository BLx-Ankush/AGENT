/**
 * ANTARDRISHTI — Metrics Collector
 *
 * Aggregates per-inference metrics for SIH evaluation reporting.
 * Records all values specified in contract §3 and §24.
 */

import type { InferenceMetrics, AggregateMetrics, InferenceBackend } from './types';

export class MetricsCollector {
  private records: InferenceMetrics[] = [];

  /** Record a single inference metric. */
  record(metrics: InferenceMetrics): void {
    this.records.push(metrics);
  }

  /** Get all recorded metrics. */
  getAll(): InferenceMetrics[] {
    return [...this.records];
  }

  /** Get aggregated metrics per model. */
  aggregate(): AggregateMetrics[] {
    const byModel = new Map<string, InferenceMetrics[]>();

    for (const m of this.records) {
      const key = `${m.modelId}:${m.backend}`;
      const list = byModel.get(key) || [];
      list.push(m);
      byModel.set(key, list);
    }

    const results: AggregateMetrics[] = [];

    for (const [, records] of byModel) {
      if (records.length === 0) continue;

      const inferenceTimes = records
        .filter((r) => r.inferenceMs > 0)
        .map((r) => r.inferenceMs)
        .sort((a, b) => a - b);

      const cold = records.find((r) => r.isCold);
      const warm = records.filter((r) => !r.isCold && r.inferenceMs > 0);

      results.push({
        modelId: records[0].modelId,
        backend: records[0].backend,
        inferenceCount: records.length,
        totalProcessedPixels: records.reduce(
          (sum, r) => sum + r.processedPixels,
          0,
        ),
        avgInferenceMs:
          inferenceTimes.length > 0
            ? inferenceTimes.reduce((s, v) => s + v, 0) / inferenceTimes.length
            : 0,
        p50InferenceMs: percentile(inferenceTimes, 0.5),
        p95InferenceMs: percentile(inferenceTimes, 0.95),
        coldStartMs: cold?.initTimeMs || 0,
        warmAvgMs:
          warm.length > 0
            ? warm.reduce((s, r) => s + r.inferenceMs, 0) / warm.length
            : 0,
        peakMemoryBytes: Math.max(
          ...records
            .map((r) => r.memoryEstimateBytes || 0),
        ),
      });
    }

    return results;
  }

  /** Clear all records. */
  clear(): void {
    this.records = [];
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
