declare module "pg-cursor" {
  export default class Cursor {
    constructor(queryText: string, values?: unknown[]);
    read(count: number, callback: (error: Error | null, rows: unknown[]) => void): void;
    close(callback: (error?: Error | null) => void): void;
  }
}
