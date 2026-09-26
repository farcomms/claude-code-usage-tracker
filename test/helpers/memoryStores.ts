import { KeyValueStore, SecretStore } from "../../src/accounts/accountStore";

export class MemorySecrets implements SecretStore {
  map = new Map<string, string>();
  async get(key: string) { return this.map.get(key); }
  async store(key: string, value: string) { this.map.set(key, value); }
  async delete(key: string) { this.map.delete(key); }
}

export class MemoryState implements KeyValueStore {
  map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown) { this.map.set(key, value); }
}
