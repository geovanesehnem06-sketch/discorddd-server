export declare function initDb(): Promise<void>;
export declare function startAutoSave(): void;
export declare function getDb(): any;
export interface QueryResult {
    rows: any[];
    changes?: number;
    lastInsertRowid?: number | bigint;
}
export declare function query(sql: string, params?: any[]): QueryResult;
export declare function testConnection(): void;
export declare function end(): Promise<void>;
export declare const pool: {
    query: typeof query;
    connect: () => Promise<{
        query: (sql: string, params?: any[]) => QueryResult;
        release: () => void;
    }>;
    testConnection: typeof testConnection;
    end: typeof end;
};
