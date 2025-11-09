/**
 * LegacyToolAdapter - 将现有工具包装为 BaseTool
 */

import { BaseTool, ToolMetadata } from './base-tool.js';

export class LegacyToolAdapter<TInput, TOutput> extends BaseTool<TInput, TOutput> {
  constructor(
    private metadata: ToolMetadata,
    private executor: (input: TInput) => Promise<TOutput>
  ) {
    super();
  }

  getMetadata(): ToolMetadata {
    return this.metadata;
  }

  protected executeImpl(input: TInput): Promise<TOutput> {
    return this.executor(input);
  }
}
