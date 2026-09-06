// Minimal ambient declaration for the slice of `bun:sqlite` @supakernel/db-sqlite uses.
// Avoids a full `@types/bun` dependency (contract §33.1 age gate) while keeping strict types.
declare module 'bun:sqlite' {
  export class Database {
    constructor(filename?: string, options?: { readonly?: boolean; create?: boolean })
    exec(sql: string): void
    query(sql: string): { all(...params: unknown[]): unknown[] }
    prepare(sql: string): {
      all(...params: unknown[]): unknown[]
      run(...params: unknown[]): { changes: number | bigint }
    }
    close(): void
  }
}
