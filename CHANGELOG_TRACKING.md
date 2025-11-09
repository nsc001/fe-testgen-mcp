# 监控数据上报功能更新日志

## v3.0.0 - 2024-11-09

### 🎉 新增功能

#### 1. 监控数据上报服务

实现了基于远程API的监控数据上报功能，可以将MCP服务器的运行状态实时上报到远程监控服务。

**核心特性：**
- ✅ 自动上报工具调用事件（成功/失败、耗时统计）
- ✅ 自动上报服务器生命周期事件（启动、关闭）
- ✅ 自动上报错误事件
- ✅ 与 Metrics 系统集成，自动上报所有指标
- ✅ 支持环境区分（dev环境不上报）
- ✅ 非侵入式设计，不影响主业务流程
- ✅ 异步上报，不阻塞主流程

**相关文件：**
- `src/utils/tracking-service.ts` - 监控上报服务实现
- `src/utils/metrics.ts` - Metrics与上报服务集成
- `src/core/app-context.ts` - 全局上下文支持
- `src/config/schema.ts` - 配置Schema扩展
- `src/config/loader.ts` - 配置加载器支持
- `config.yaml` - 默认配置
- `TRACKING_GUIDE.md` - 使用指南

#### 2. FastMCP 集成

集成了 `fastmcp` 库，提供简化的MCP服务器实现和内置HTTP Streaming支持。

**核心特性：**
- ✅ 简化的工具注册流程
- ✅ 内置 HTTP Streaming (SSE) 支持
- ✅ 自动连接管理
- ✅ 完整的监控数据上报支持
- ✅ 与标准版本功能对等

**相关文件：**
- `src/index-fastmcp.ts` - FastMCP实现
- `package.json` - 新增 `start:fastmcp` 命令
- `tsup.config.ts` - 构建配置更新

### 🔧 改进

#### 1. Metrics系统增强

```typescript
// 支持自动上报到远程监控服务
export class TrackingMetricsClient extends InMemoryMetricsClient {
  // 在记录指标的同时自动上报
  override recordCounter(name: string, value: MetricValue = 1, labels?: MetricLabels): void {
    super.recordCounter(name, value, labels);
    this.trackMetric('counter', name, value, labels);
  }
  // ...
}
```

#### 2. ToolRegistry扩展

```typescript
// 新增 listAll() 方法，支持加载所有惰性工具
async listAll(): Promise<BaseTool<any, any>[]> {
  const lazyNames = Array.from(this.lazyTools.keys());
  await Promise.all(lazyNames.map(name => this.get(name)));
  return this.list();
}
```

#### 3. HTTP Transport增强

- 自动上报工具调用事件
- 自动上报错误事件
- 集成到全局上下文

#### 4. 服务器生命周期追踪

- 初始化事件上报
- 启动事件上报
- 关闭事件上报
- 致命错误上报

### 📝 配置说明

#### 环境变量配置

```bash
# 监控数据上报配置（可选）
TRACKING_ENABLED=true                # 是否启用上报（默认 true）
TRACKING_APP_ID=MCP_SERVICE          # 应用标识
TRACKING_APP_VERSION=3.0.0           # 应用版本
TRACKING_ENV=prod                    # 环境：dev/test/prod
TRACKING_MEASUREMENT=mcp_service_metrics  # 指标名称
TRACKING_METRICS_TYPE=metricsType1   # 指标类型
```

#### YAML配置

```yaml
tracking:
  enabled: true
  appId: MCP_SERVICE
  appVersion: 3.0.0
  env: prod  # dev（不上报）、test、prod（统一使用测试环境地址）
  measurement: mcp_service_metrics
  metricsType: metricsType1
```

### 🚀 使用方式

#### 标准版本（推荐）

```bash
# Stdio 模式
npm start

# HTTP 模式
npm start -- --transport=http
TRANSPORT_MODE=http HTTP_PORT=3000 npm start
```

#### FastMCP 版本（实验性）

```bash
# Stdio 模式
npm run start:fastmcp

# HTTP Streaming 模式（支持 SSE）
npm run start:fastmcp -- --transport=httpStream
TRANSPORT_MODE=httpStream HTTP_PORT=3000 npm run start:fastmcp
```

### 📊 上报数据格式

#### 工具调用事件

```json
{
  "eventType": "tool_call",
  "toolName": "fetch-diff",
  "duration": 150,
  "status": "success",
  "errorMessage": null
}
```

#### 服务器事件

```json
{
  "eventType": "server_started",
  "transport": "stdio",
  "timestamp": 1704067200000
}
```

#### Metrics 事件

```json
{
  "eventType": "metric_recorded",
  "metricType": "counter",
  "metricName": "tool.execution.started",
  "value": 1,
  "labels": {
    "tool": "fetch-diff"
  }
}
```

### 🔐 上报接口

- **URL**: `https://event-tracking-api-test.yangqianguan.com/logMetrics`
- **方法**: `POST`
- **Headers**:
  - `YQG-PLATFORM-SDK-TYPE`: `{appId}`
  - `CONTENT-TYPE`: `application/json;charset=UTF-8`
  - `Country`: `CN`

### 📖 文档

- [TRACKING_GUIDE.md](./TRACKING_GUIDE.md) - 监控数据上报功能使用指南
- [监控数据上报接口说明.md](./监控数据上报接口说明.md) - 接口详细说明
- [README.md](./README.md) - 项目主文档（已更新）

### 🎯 设计原则

1. **非侵入式**：上报功能不影响主业务流程
2. **异步执行**：所有上报操作异步执行，不阻塞主流程
3. **容错性**：上报失败不会导致服务异常
4. **环境感知**：开发环境不上报，便于本地调试
5. **灵活配置**：支持环境变量和配置文件两种方式

### 🛠️ 技术实现

#### MCPTrackingService

```typescript
export class MCPTrackingService {
  // 基础上报
  async track(parameter: Record<string, any>, level?: 'INFO' | 'WARN' | 'ERROR', message?: string): Promise<void>
  
  // 批量上报
  async trackBatch(entries: Array<{ parameter: Record<string, any>; message?: string }>, level?: 'INFO' | 'WARN' | 'ERROR'): Promise<void>
  
  // 工具调用上报
  async trackToolCall(toolName: string, duration: number, status: 'success' | 'error', errorMessage?: string): Promise<void>
  
  // Agent执行上报
  async trackAgentExecution(agentName: string, duration: number, status: 'success' | 'error', metadata?: Record<string, any>): Promise<void>
  
  // 服务器事件上报
  async trackServerEvent(eventType: string, metadata?: Record<string, any>): Promise<void>
  
  // 错误上报
  async trackError(errorType: string, errorMessage: string, metadata?: Record<string, any>): Promise<void>
}
```

#### TrackingMetricsClient

```typescript
class TrackingMetricsClient extends InMemoryMetricsClient {
  // 自动将Metrics同步上报到远程监控服务
  override recordCounter(name: string, value: MetricValue = 1, labels?: MetricLabels): void
  override recordTimer(name: string, durationMs: MetricValue, labels?: MetricLabels): void
  override recordHistogram(name: string, value: MetricValue, labels?: MetricLabels): void
  override recordGauge(name: string, value: MetricValue, labels?: MetricLabels): void
}
```

### 🔄 集成点

1. **服务器初始化** (`src/index.ts`, `src/index-fastmcp.ts`)
   - 初始化 TrackingService
   - 集成到 Metrics 系统
   - 注入到全局上下文

2. **工具调用** (`src/index.ts`, `src/index-fastmcp.ts`, `src/transports/http.ts`)
   - 调用开始：记录时间
   - 调用成功：上报成功事件
   - 调用失败：上报错误事件

3. **服务器生命周期** (`src/index.ts`, `src/index-fastmcp.ts`)
   - 初始化完成：上报初始化事件
   - 服务器启动：上报启动事件
   - 服务器关闭：上报关闭事件
   - 致命错误：上报错误事件

4. **Metrics系统** (`src/utils/metrics.ts`)
   - 自动将所有指标同步上报到远程监控服务

### 🧪 测试建议

1. **开发环境测试**：设置 `TRACKING_ENV=dev`，检查日志输出
2. **生产环境测试**：设置 `TRACKING_ENV=prod`，验证数据上报
3. **错误处理测试**：模拟网络故障，确保不影响主流程
4. **性能测试**：验证上报操作不会造成明显性能损失

### ⚠️ 注意事项

1. 开发环境不会真实上报数据，仅输出日志
2. 上报失败不会影响主业务流程
3. 确保能够访问上报接口地址
4. 不要在上报数据中包含敏感信息

### 🎓 最佳实践

1. 在生产环境启用上报功能
2. 定期检查上报数据，分析服务运行状况
3. 根据上报数据优化性能和稳定性
4. 结合 Prometheus 指标进行综合监控

## 下一步计划

- [ ] 添加 Grafana Dashboard 模板
- [ ] 实现数据聚合和分析功能
- [ ] 添加告警规则
- [ ] 支持更多监控服务提供商
