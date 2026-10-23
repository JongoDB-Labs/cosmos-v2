// Types for routes.mjs (imported by src/lib/openapi/coverage.arch.test.ts).
export const ROOT: string;
export const INTERNAL_ROUTES_FILE: string;
export function routePath(file: string): string;
export function exportedMethods(source: string): string[];
export function routeFiles(): string[];
export function contractFiles(): string[];
export function scanOperations(): { key: string; file: string }[];
export function operationKey(method: string, path: string): string;
export function readInternalRoutes(): string[];
export function formatInternalRoutes(keys: Iterable<string>): string;
