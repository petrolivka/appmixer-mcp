import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeError } from './errors.js';

export const MAX_RESULT_CHARS = 20_000;

export function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n… [truncated, ${text.length - max} characters omitted]`;
}

export function textResult(value: unknown, maxChars = MAX_RESULT_CHARS): CallToolResult {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: 'text', text: truncate(text, maxChars) }] };
}

export function errorResult(err: unknown): CallToolResult {
    return { isError: true, content: [{ type: 'text', text: describeError(err) }] };
}

/** Wrap a tool handler so any thrown error becomes an actionable isError result. */
export function safeHandler<A>(
    handler: (args: A) => Promise<CallToolResult>
): (args: A) => Promise<CallToolResult> {
    return async (args: A) => {
        try {
            return await handler(args);
        } catch (err) {
            return errorResult(err);
        }
    };
}
