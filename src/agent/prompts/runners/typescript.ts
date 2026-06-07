export function buildTsRule(mockApi: string): string {
  return `
9. TypeScript type safety: all test code must compile without type errors. The TypeScript compiler is the authority — its error messages are exact instructions, not hints.
   - Use EXACT property/member names from the TYPE DEFINITIONS section and source code. Do not apply naming conventions: if a hook returns { loading, users }, do NOT write isLoading or isUsers.
   - Import enums, constants, interfaces, and types from the project's existing files. Do NOT redeclare them inline or invent lookalike values.
   - Never use "as any", "@ts-ignore", or "@ts-expect-error" to suppress type errors.
   - For ${mockApi}.fn(), either let TypeScript infer the type from context or type it explicitly: ${mockApi}.fn<Parameters<typeof fn>, ReturnType<typeof fn>>().
   - Use ReturnType<>, Parameters<>, and other utility types to derive mock types from real function signatures.
   - When accessing optional properties, handle null/undefined correctly.
   - Array types: always use T[] syntax, never Array<T> — @typescript-eslint/array-type will flag the generic form. For inline object arrays use \`{ field: type }[]\` not \`Array<{ field: type }>\`.`
}
