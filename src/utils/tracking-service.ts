/**
 * MCPTrackingService - 监控数据上报服务
 * 参考 @yqg/multiple-click 实现，适配服务端场景
 */

import { logger } from './logger.js';

export interface MCPTrackingConfig {
  /** 项目标识 */
  appId: string;
  /** 项目版本号（可选） */
  appVersion?: string;
  /** 环境：dev（不上报）、test、prod（统一使用测试环境地址） */
  env: string;
  /** 指标名称（可选，默认：mcp_service_metrics） */
  measurement?: string;
  /** 指标类型（可选，默认：metricsType1） */
  metricsType?: string;
}

export interface TrackingLogEntry {
  appId: string;
  appVersion: string | null;
  osType: string | null;
  measurement: string;
  metricsType: string;
  time: string;
  message: string;
  parameter: Record<string, any>;
}

export interface TrackingRequest {
  level: 'INFO' | 'WARN' | 'ERROR';
  logs: TrackingLogEntry[];
}

/**
 * 获取上报 URL
 */
function getTrackingUrl(env: string): string | null {
  // MCP 服务端场景下，只需要测试环境
  if (env === 'dev') {
    return null; // 开发环境不上报
  }

  // 其他环境统一使用测试环境地址
  return 'https://event-tracking-api-test.yangqianguan.com/logMetrics';
}

/**
 * MCPTrackingService - 监控数据上报服务类
 */
export class MCPTrackingService {
  private config: MCPTrackingConfig;
  private trackingUrl: string | null;

  constructor(config: MCPTrackingConfig) {
    this.config = {
      ...config,
      measurement: config.measurement || 'mcp_service_metrics',
      metricsType: config.metricsType || 'metricsType1',
    };
    this.trackingUrl = getTrackingUrl(config.env);

    if (this.trackingUrl) {
      logger.info('[TrackingService] Initialized', {
        appId: this.config.appId,
        env: this.config.env,
        url: this.trackingUrl,
      });
    } else {
      logger.info('[TrackingService] Disabled for development environment');
    }
  }

  /**
   * 上报监控数据
   * @param parameter 自定义的上报数据
   * @param level 日志级别，默认 INFO
   * @param message 消息描述，默认 'mcp service monitoring'
   */
  async track(
    parameter: Record<string, any>,
    level: 'INFO' | 'WARN' | 'ERROR' = 'INFO',
    message: string = 'mcp service monitoring'
  ): Promise<void> {
    // 开发环境不上报
    if (!this.trackingUrl) {
      logger.debug('[TrackingService] Skip tracking in dev environment', { parameter });
      return;
    }

    // 构建请求头
    const headers = {
      'YQG-PLATFORM-SDK-TYPE': this.config.appId,
      'CONTENT-TYPE': 'application/json;charset=UTF-8',
      'Country': 'CN', // MCP 服务端固定为 CN
    };

    // 构建请求体
    const requestBody: TrackingRequest = {
      level,
      logs: [
        {
          appId: this.config.appId,
          appVersion: this.config.appVersion || null,
          osType: 'Server', // 服务端固定为 Server
          measurement: this.config.measurement!,
          metricsType: this.config.metricsType!,
          time: Date.now().toString(),
          message,
          parameter,
        },
      ],
    };

    try {
      const response = await fetch(this.trackingUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        logger.warn('[TrackingService] Upload failed', {
          status: response.status,
          statusText: response.statusText,
        });
      } else {
        logger.debug('[TrackingService] Upload successful', {
          measurement: this.config.measurement,
          level,
        });
      }
    } catch (err) {
      logger.error('[TrackingService] Upload exception', { error: err });
    }
  }

  /**
   * 批量上报监控数据
   * @param entries 多条上报数据
   * @param level 日志级别，默认 INFO
   */
  async trackBatch(
    entries: Array<{ parameter: Record<string, any>; message?: string }>,
    level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'
  ): Promise<void> {
    // 开发环境不上报
    if (!this.trackingUrl) {
      logger.debug('[TrackingService] Skip batch tracking in dev environment');
      return;
    }

    // 构建请求头
    const headers = {
      'YQG-PLATFORM-SDK-TYPE': this.config.appId,
      'CONTENT-TYPE': 'application/json;charset=UTF-8',
      'Country': 'CN',
    };

    // 构建请求体
    const requestBody: TrackingRequest = {
      level,
      logs: entries.map((entry) => ({
        appId: this.config.appId,
        appVersion: this.config.appVersion || null,
        osType: 'Server',
        measurement: this.config.measurement!,
        metricsType: this.config.metricsType!,
        time: Date.now().toString(),
        message: entry.message || 'mcp service monitoring',
        parameter: entry.parameter,
      })),
    };

    try {
      const response = await fetch(this.trackingUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        logger.warn('[TrackingService] Batch upload failed', {
          status: response.status,
          statusText: response.statusText,
          count: entries.length,
        });
      } else {
        logger.debug('[TrackingService] Batch upload successful', {
          count: entries.length,
        });
      }
    } catch (err) {
      logger.error('[TrackingService] Batch upload exception', { error: err });
    }
  }

  /**
   * 上报工具调用事件
   */
  async trackToolCall(toolName: string, duration: number, status: 'success' | 'error', errorMessage?: string): Promise<void> {
    await this.track({
      eventType: 'tool_call',
      toolName,
      duration,
      status,
      errorMessage: errorMessage || null,
    });
  }

  /**
   * 上报Agent执行事件
   */
  async trackAgentExecution(
    agentName: string,
    duration: number,
    status: 'success' | 'error',
    metadata?: Record<string, any>
  ): Promise<void> {
    await this.track({
      eventType: 'agent_execution',
      agentName,
      duration,
      status,
      ...metadata,
    });
  }

  /**
   * 上报服务器事件
   */
  async trackServerEvent(eventType: string, metadata?: Record<string, any>): Promise<void> {
    await this.track({
      eventType: `server_${eventType}`,
      timestamp: Date.now(),
      ...metadata,
    });
  }

  /**
   * 上报错误事件
   */
  async trackError(errorType: string, errorMessage: string, metadata?: Record<string, any>): Promise<void> {
    await this.track(
      {
        eventType: 'error',
        errorType,
        errorMessage,
        timestamp: Date.now(),
        ...metadata,
      },
      'ERROR',
      `Error: ${errorType}`
    );
  }
}
