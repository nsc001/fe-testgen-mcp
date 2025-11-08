/**
 * Lightweight metrics facade used across the MCP server.
 *
 * Goals:
 *  - Provide a consistent interface without forcing a concrete backend
 *  - Enable future integration with Prometheus / Datadog, etc.
 *  - Offer a zero-dependency in-memory implementation by default
 */

import { logger } from './logger.js';

export type MetricValue = number;

export interface MetricLabels {
  [key: string]: string | number | boolean | undefined;
}

export interface MetricsClient {
  recordCounter(name: string, value?: MetricValue, labels?: MetricLabels): void;
  recordTimer(name: string, durationMs: MetricValue, labels?: MetricLabels): void;
  recordHistogram(name: string, value: MetricValue, labels?: MetricLabels): void;
  recordGauge(name: string, value: MetricValue, labels?: MetricLabels): void;
  export(): MetricSnapshot[];
  reset(): void;
}

export interface MetricSnapshot {
  name: string;
  type: 'counter' | 'timer' | 'histogram' | 'gauge';
  value: MetricValue;
  labels?: MetricLabels;
  timestamp: number;
}

/**
 * Default in-memory implementation used unless an external client is provided.
 */
export class InMemoryMetricsClient implements MetricsClient {
  private records: MetricSnapshot[] = [];
  private readonly logMetrics: boolean;

  constructor(options: { logMetrics?: boolean } = {}) {
    this.logMetrics = options.logMetrics ?? false;
  }

  recordCounter(name: string, value: MetricValue = 1, labels?: MetricLabels): void {
    this.pushRecord('counter', name, value, labels);
  }

  recordTimer(name: string, durationMs: MetricValue, labels?: MetricLabels): void {
    this.pushRecord('timer', name, durationMs, labels);
  }

  recordHistogram(name: string, value: MetricValue, labels?: MetricLabels): void {
    this.pushRecord('histogram', name, value, labels);
  }

  recordGauge(name: string, value: MetricValue, labels?: MetricLabels): void {
    this.pushRecord('gauge', name, value, labels);
  }

  export(): MetricSnapshot[] {
    return [...this.records];
  }

  reset(): void {
    this.records = [];
  }

  private pushRecord(type: MetricSnapshot['type'], name: string, value: MetricValue, labels?: MetricLabels) {
    const snapshot: MetricSnapshot = {
      name,
      type,
      value,
      labels,
      timestamp: Date.now(),
    };
    this.records.push(snapshot);

    if (this.logMetrics) {
      logger.debug('[metrics]', snapshot);
    }
  }
}

let client: MetricsClient | undefined;

export function initializeMetrics(customClient?: MetricsClient): void {
  client = customClient ?? new InMemoryMetricsClient({ logMetrics: process.env.LOG_METRICS === 'true' });
  logger.info('Metrics client initialized', { client: client.constructor.name });
}

export function getMetrics(): MetricsClient {
  if (!client) {
    initializeMetrics();
  }
  return client!;
}

/**
 * Helper to measure async execution time.
 */
export async function withTimer<T>(
  metricName: string,
  labels: MetricLabels | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    getMetrics().recordTimer(metricName, Date.now() - startedAt, { ...labels, status: 'success' });
    return result;
  } catch (error) {
    getMetrics().recordTimer(metricName, Date.now() - startedAt, { ...labels, status: 'error' });
    throw error;
  }
}
