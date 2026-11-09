/**
 * Native dynamic import. TypeScript compiles `import()` to `require()` under
 * `module: commonjs`, which fails for ESM-only packages such as
 * `@huggingface/transformers`. Going through `new Function` preserves a real
 * `import()` at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
export const dynamicImport = new Function('specifier', 'return import(specifier)') as <T = any>(
  specifier: string,
) => Promise<T>;
