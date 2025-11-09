/**
 * ToolRegistry - 统一管理所有工具的注册、检索与元数据导出
 */

import { BaseTool, ToolMetadata } from './base-tool.js';

export class ToolRegistry {
  private tools = new Map<string, BaseTool<any, any>>();

  register(tool: BaseTool<any, any>): void {
    const metadata = tool.getMetadata();
    if (this.tools.has(metadata.name)) {
      throw new Error(`Tool "${metadata.name}" already registered`);
    }
    this.tools.set(metadata.name, tool);
  }

  get<TInput, TOutput>(name: string): BaseTool<TInput, TOutput> | undefined {
    return this.tools.get(name) as BaseTool<TInput, TOutput> | undefined;
  }

  list(): BaseTool<any, any>[] {
    return Array.from(this.tools.values());
  }

  listMetadata(): ToolMetadata[] {
    return this.list().map(tool => tool.getMetadata());
  }
}
