import type { PolicyDto } from "@ghostlink/common";

export interface BotDeployment {
  cluster: "localnet";
  genesisHash: string;
  pocketProgram: string;
  registryProgram: string;
  censusProgram: string;
}

/** Public consent fields only. No bot seed, owner identity or witness. */
export interface BotConsent {
  version: 1;
  id: string;
  botId: string;
  userId: string;
  appOrigin: string;
  deployment: BotDeployment;
  appId: string;
  pocket: string;
  home: string;
  policy: PolicyDto;
  sessionKeyHex: string;
  sessionExpirySlot: string;
  createdAt: number;
  expiresAt: number;
}

export type ConsentState = "pending" | "confirmed" | "cancelled" | "expired";
export interface ConsentStatus { consent: BotConsent; state: ConsentState; confirmedSlot?: number }
