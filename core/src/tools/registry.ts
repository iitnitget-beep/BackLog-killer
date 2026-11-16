import type { Platform } from '../platform/types';
import { safePath as safePathFrom } from '../platform/types';
import type { PermissionClass, ToolContext, ToolDefinition, ToolResultEnvelope } from './types';
import { ToolError } from './types';
import { editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool } from './filesystem';
import { shellTool } from './shell';

export interface ToolRegistryOptions {
  allowedCommands?: string[];
  /** Tools withheld from a given agent (freebuff's `withheld` tool list pattern). */
  exclude?: string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  /** Set when the registry is built from a platform, so hooks can check existence. */
  workspaceExists?: (relativePath: string) => Promise<boolean>;

  constructor(tools: ToolDefinition[]) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  static standard(
    platform: Platform,
    root: string,
    options: ToolRegistryOptions = {},
    extra: ToolDefinition[] = [],
  ): ToolRegistry {
    const tools: ToolDefinition[] = [
      readFileTool(platform, root),
      writeFileTool(platform, root),
      editFileTool(platform, root),
      listDirTool(platform, root),
      globTool(platform, root),
      grepTool(platform, root),
      shellTool(platform, root, { allowedCommands: options.allowedCommands }),
      ...extra,
    ];
    const exclude = new Set(options.exclude ?? []);
    const registry = new ToolRegistry(tools.filter((tool) => !exclude.has(tool.name)));
    registry.workspaceExists = async (relativePath: string) =>
      platform.fs.exists(safePathFrom(root, relativePath));
    return registry;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Declarations for the model's function-calling payload. */
  declarations(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.spec.description,
      parameters: tool.spec.parameters,
    }));
  }

  /** Tool subset used to build a sub-agent's registry. */
  subset(names: string[]): ToolRegistry {
    const selected = names.map((n) => this.tools.get(n)).filter((t): t is ToolDefinition => Boolean(t));
    return new ToolRegistry(selected);
  }

  permissionFor(name: string, args: Record<string, unknown>): PermissionClass {
    const tool = this.tools.get(name);
    if (!tool) return 'deny';
    return tool.permission(args);
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResultEnvelope> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolError(`unknown tool: ${name}`, 'ENOTOOL');
    }
    return (await tool.run(args, context)) as ToolResultEnvelope;
  }
}
