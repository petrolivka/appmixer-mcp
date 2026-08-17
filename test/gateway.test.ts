import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { sanitizeToolName, uniqueName } from '../src/tools/gateway.js';
import { jsonSchemaToZod } from '../src/tools/json-schema-to-zod.js';

describe('sanitizeToolName', () => {

    it('replaces invalid characters and enforces the 64-char limit', () => {
        expect(sanitizeToolName('my tool (v2)!')).toBe('my_tool__v2__');
        expect(sanitizeToolName('x'.repeat(100))).toHaveLength(64);
        expect(sanitizeToolName('')).toBe('tool');
    });
});

describe('uniqueName', () => {

    it('suffixes duplicates while keeping the length limit', () => {
        const taken = new Set(['dup', 'dup_2']);
        expect(uniqueName('fresh', taken)).toBe('fresh');
        expect(uniqueName('dup', taken)).toBe('dup_3');
        const long = 'y'.repeat(64);
        const result = uniqueName(long, new Set([long]));
        expect(result).toHaveLength(64);
        expect(result.endsWith('_2')).toBe(true);
    });
});

describe('jsonSchemaToZod', () => {

    const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The name.' },
            count: { type: 'integer' },
            enabled: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
            level: { type: 'string', enum: ['low', 'high'] },
            nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }
        },
        required: ['name']
    });

    it('validates conforming input', () => {
        const parsed = schema.safeParse({
            name: 'a', count: 3, enabled: true, tags: ['t'], level: 'low', nested: { x: 1.5 }
        });
        expect(parsed.success).toBe(true);
    });

    it('enforces required fields and types', () => {
        expect(schema.safeParse({}).success).toBe(false);                      // missing name
        expect(schema.safeParse({ name: 'a', count: 'NaN' }).success).toBe(false);
        expect(schema.safeParse({ name: 'a', level: 'medium' }).success).toBe(false);
    });

    it('is loose about undeclared properties', () => {
        expect(schema.safeParse({ name: 'a', extra: 42 }).success).toBe(true);
    });

    it('degrades to unknown for unrecognized schemas', () => {
        const anything = jsonSchemaToZod({ type: 'weird' });
        expect(anything.safeParse({ whatever: true }).success).toBe(true);
    });

    it('returns an object schema even for empty parameters', () => {
        const empty = jsonSchemaToZod(undefined);
        expect(empty).toBeInstanceOf(z.ZodType);
        expect(empty.safeParse({}).success).toBe(true);
    });
});
