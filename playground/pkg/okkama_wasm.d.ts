/* tslint:disable */
/* eslint-disable */

export function ast(request: string): string;

export function check(request: string): string;

export function complete(request: string): string;

export function definition(request: string): string;

export function fmt(request: string): string;

export function hover(request: string): string;

export function ir(request: string): string;

export function setFiles(request: string): string;

export function signature(request: string): string;

export function spa(request: string): string;

export function tokens(request: string): string;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly ast: (a: number, b: number) => [number, number];
    readonly check: (a: number, b: number) => [number, number];
    readonly complete: (a: number, b: number) => [number, number];
    readonly definition: (a: number, b: number) => [number, number];
    readonly fmt: (a: number, b: number) => [number, number];
    readonly hover: (a: number, b: number) => [number, number];
    readonly ir: (a: number, b: number) => [number, number];
    readonly setFiles: (a: number, b: number) => [number, number];
    readonly signature: (a: number, b: number) => [number, number];
    readonly spa: (a: number, b: number) => [number, number];
    readonly tokens: (a: number, b: number) => [number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
