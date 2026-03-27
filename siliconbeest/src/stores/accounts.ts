import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Account, Relationship } from '@/types/mastodon';
import {
  getAccount as fetchAccount,
  getRelationships as fetchRelationships,
} from '@/api/mastodon/accounts';

export const useAccountsStore = defineStore('accounts', () => {
  const cache = ref<Map<string, Account>>(new Map());
  const relationships = ref<Map<string, Relationship>>(new Map());

  function cacheAccount(account: Account) {
    cache.value.set(account.id, account);
  }

  function cacheAccounts(accounts: Account[]) {
    for (const account of accounts) {
      cache.value.set(account.id, account);
    }
  }

  function getCached(id: string): Account | undefined {
    return cache.value.get(id);
  }

  async function getAccount(id: string, token?: string): Promise<Account> {
    const cached = cache.value.get(id);
    if (cached) return cached;

    const { data } = await fetchAccount(id, token);
    cacheAccount(data);
    return data;
  }

  async function getRelationships(ids: string[], token: string) {
    if (ids.length === 0) return [];
    const { data } = await fetchRelationships(ids, token);
    for (const rel of data) {
      relationships.value.set(rel.id, rel);
    }
    return data;
  }

  function getRelationship(id: string): Relationship | undefined {
    return relationships.value.get(id);
  }

  function updateRelationship(rel: Relationship) {
    relationships.value.set(rel.id, rel);
  }

  return {
    cache,
    relationships,
    cacheAccount,
    cacheAccounts,
    getCached,
    getAccount,
    getRelationships,
    getRelationship,
    updateRelationship,
  };
});
