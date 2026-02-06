import { Cache } from "drizzle-orm/cache/core";
import type { CacheConfig } from "drizzle-orm/cache/core/types";
import { Table, getTableName, is } from "drizzle-orm";
import type { Redis } from "ioredis";

/** Configuration options for Redis-based query caching */
export interface RedisCacheOptions {
  redis: Redis;
  global?: boolean;
  defaultTtl?: number;
  prefix?: string;
}

/**
 * Custom cache implementation using Redis for Drizzle ORM.
 * Handles query result caching with automatic invalidation.
 */
export class RedisCache extends Cache {
  private redis: Redis;
  private globalStrategy: boolean;
  private defaultTtl: number;
  private prefix: string;
  private usedTablesPerKey: Record<string, string[]> = {};

  constructor(options: RedisCacheOptions) {
    super();
    if (!options || !options.redis) {
      throw new Error("Redis client is required in RedisCacheOptions.redis");
    }
    this.redis = options.redis;
    this.globalStrategy = options.global ?? false;
    this.defaultTtl = options.defaultTtl ?? 60;
    this.prefix = options.prefix ?? "drizzle";
  }

  private buildKey(key: string): string {
    return `${this.prefix}:query:${key}`;
  }

  private buildTableKey(table: string): string {
    return `${this.prefix}:tables:${table}`;
  }

  override strategy(): "explicit" | "all" {
    return this.globalStrategy ? "all" : "explicit";
  }

  override async get(key: string): Promise<unknown[] | undefined> {
    const fullKey = this.buildKey(key);
    try {
      const cached = await this.redis.get(fullKey);
      if (cached !== null) {
        return JSON.parse(cached) as unknown[];
      }
      return undefined;
    } catch {
      /* empty */
    }
    return undefined;
  }

  override async put(
    key: string,
    response: unknown,
    tables: string[],
    isTag: boolean,
    config?: CacheConfig,
  ): Promise<void> {
    const fullKey = this.buildKey(key);
    let ttlSeconds: number;
    if (config?.px) {
      ttlSeconds = Math.ceil(config.px / 1000);
    } else if (config?.ex) {
      ttlSeconds = config.ex;
    } else {
      ttlSeconds = this.defaultTtl;
    }

    try {
      const serialized = JSON.stringify(response);
      if (config?.keepTtl) {
        await this.redis.set(fullKey, serialized, "KEEPTTL");
      } else if (config?.exat) {
        await this.redis.set(fullKey, serialized, "EXAT", config.exat);
      } else if (config?.pxat) {
        await this.redis.set(fullKey, serialized, "PXAT", config.pxat);
      } else {
        await this.redis.set(fullKey, serialized, "EX", ttlSeconds);
      }
      await this.trackTablesForKey(key, tables);
    } catch {
      /* empty */
    }
  }

  private async trackTablesForKey(
    key: string,
    tables: string[],
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const table of tables) {
      const tableKey = this.buildTableKey(table);
      pipeline.sadd(tableKey, key);
      pipeline.expire(tableKey, this.defaultTtl * 10);
    }
    for (const table of tables) {
      if (!this.usedTablesPerKey[table]) {
        this.usedTablesPerKey[table] = [];
      }
      if (!this.usedTablesPerKey[table].includes(key)) {
        this.usedTablesPerKey[table].push(key);
      }
    }
    await pipeline.exec();
  }

  override async onMutate(params: {
    tags: string | string[];
    tables: string | string[] | Table | Table[];
  }): Promise<void> {
    const tagsArray = params.tags
      ? Array.isArray(params.tags)
        ? params.tags
        : [params.tags]
      : [];

    const tablesArray = params.tables
      ? Array.isArray(params.tables)
        ? params.tables
        : [params.tables]
      : [];

    const keysToDelete = new Set<string>();

    try {
      for (const table of tablesArray) {
        const tableName = is(table, Table)
          ? getTableName(table)
          : (table as string);
        const tableKey = this.buildTableKey(tableName);
        const keys = await this.redis.smembers(tableKey);
        for (const key of keys) {
          keysToDelete.add(key);
        }
        const memoryKeys = this.usedTablesPerKey[tableName] ?? [];
        for (const key of memoryKeys) {
          keysToDelete.add(key);
        }
      }

      if (keysToDelete.size > 0 || tagsArray.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const tag of tagsArray) {
          const tagKey = this.buildKey(tag);
          pipeline.del(tagKey);
        }
        for (const key of keysToDelete) {
          const fullKey = this.buildKey(key);
          pipeline.del(fullKey);
        }
        for (const table of tablesArray) {
          const tableName = is(table, Table)
            ? getTableName(table)
            : (table as string);
          const tableKey = this.buildTableKey(tableName);
          pipeline.del(tableKey);
          this.usedTablesPerKey[tableName] = [];
        }
        await pipeline.exec();
      }
    } catch {
      /* empty */
    }
  }
}

export function redisCache(options: RedisCacheOptions): RedisCache {
  return new RedisCache(options);
}

export default redisCache;
