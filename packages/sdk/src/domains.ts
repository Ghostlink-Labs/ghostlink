/**
 * Visited-domain list for recovery (build plan 4.5.3): after signing in
 * again on a new device, the SDK re-derives every app_id and pocket from
 * the secret plus this list of origins. Storage is injectable; apps on
 * the web can pass localStorage. The list contains no identity secrets,
 * but it does reveal visited app origins; treat it as browsing history.
 */
import { FieldElement, appId, domainHash, pocketPda } from "@ghostlink/common";

export interface DomainStore {
  load(): string[];
  save(domains: string[]): void;
}

export function memoryDomainStore(initial: string[] = []): DomainStore {
  let domains = [...initial];
  return {
    load: () => [...domains],
    save: (d) => {
      domains = [...d];
    },
  };
}

export function webDomainStore(key = "ghostlink:visited-domains"): DomainStore {
  return {
    load() {
      try {
        return JSON.parse(globalThis.localStorage?.getItem(key) ?? "[]") as string[];
      } catch {
        return [];
      }
    },
    save(domains) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(domains));
      } catch {
        // storage unavailable: the indexer-side pocket scan still works
      }
    },
  };
}

export function rememberDomain(store: DomainStore, origin: string): void {
  const domains = store.load();
  if (!domains.includes(origin)) {
    domains.push(origin);
    store.save(domains);
  }
}

export interface RecoveredPocket {
  origin: string;
  appId: FieldElement;
  pocketAddress: Uint8Array;
}

/** Re-derives every known app identity and pocket from the secret. */
export function recoverPockets(sField: FieldElement, origins: string[]): RecoveredPocket[] {
  return origins.map((origin) => {
    const id = appId(sField, domainHash(origin));
    return { origin, appId: id, pocketAddress: pocketPda(id).address };
  });
}
