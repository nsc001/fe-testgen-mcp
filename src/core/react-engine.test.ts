import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OpenAIClient } from '../clients/openai.js';
import { ReActEngine } from './react-engine.js';
import { ToolRegistry } from './tool-registry.js';
import { ContextStore } from './context.js';
import { BaseTool, type ToolMetadata } from './base-tool.js';

describe('ReActEngine Function Calling', () => {
  class EchoTool extends BaseTool<{ message: string }, { echoed: string }> {
    private calls: Array<{ message: string }> = [];

    getMetadata(): ToolMetadata {
      return {
        name: 'echo-tool',
        description: 'Echo back the provided message.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Message to echo back',
            },
          },
          required: ['message'],
        },
      };
    }

    protected async executeImpl(input: { message: string }): Promise<{ echoed: string }> {
      this.calls.push(input);
      return { echoed: input.message };
    }

    getCallCount(): number {
      return this.calls.length;
    }

    getLastCall(): { message: string } | undefined {
      return this.calls[this.calls.length - 1];
    }
  }

  let tool: EchoTool;
  let toolRegistry: ToolRegistry;
  let contextStore: ContextStore;
  let openAI: OpenAIClient;

  beforeEach(() => {
    tool = new EchoTool();
    toolRegistry = new ToolRegistry();
    toolRegistry.register(tool);
    contextStore = new ContextStore();
  });

  it('executes tools using function calling responses', async () => {
    const firstChoice = {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'echo-tool',
              arguments: JSON.stringify({ message: 'hello world' }),
            },
          },
        ],
      },
    } as any;

    const secondChoice = {
      message: {
        role: 'assistant',
        content: 'Final answer: completed',
      },
    } as any;

    const completeWithToolCalls = vi
      .fn()
      .mockResolvedValueOnce(firstChoice)
      .mockResolvedValueOnce(secondChoice);

    openAI = {
      complete: vi.fn(),
      completeWithToolCalls,
    } as unknown as OpenAIClient;

    const engine = new ReActEngine(openAI, toolRegistry, contextStore, {
      maxSteps: 5,
      temperature: 0,
      stopReasons: [],
      useFunctionCalling: true,
    });

    const result = await engine.run({
      agentName: 'test-agent',
      task: 'Execute echo tool',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(result.success).toBe(true);
    expect(tool.getCallCount()).toBe(1);
    expect(tool.getLastCall()).toEqual({ message: 'hello world' });
    expect(result.context.data.finalAnswer).toBe('Final answer: completed');
    expect(completeWithToolCalls).toHaveBeenCalledTimes(2);
  });

  it('falls back to parsing text instructions when function calling is disabled', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce('Call tool: echo-tool\nParameters: {"message":"fallback"}')
      .mockResolvedValueOnce('Final answer: done');

    openAI = {
      complete,
      completeWithToolCalls: vi.fn(),
    } as unknown as OpenAIClient;

    const engine = new ReActEngine(openAI, toolRegistry, contextStore, {
      maxSteps: 5,
      temperature: 0,
      stopReasons: [],
      useFunctionCalling: false,
    });

    const result = await engine.run({
      agentName: 'test-agent',
      task: 'Execute echo tool without function calling',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(result.success).toBe(true);
    expect(tool.getCallCount()).toBe(1);
    expect(tool.getLastCall()).toEqual({ message: 'fallback' });
    expect(result.context.data.finalAnswer).toBe('Final answer: done');
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
