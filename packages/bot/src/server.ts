import { HttpError, RateLimiter, Router, clientIp } from "@ghostlink/service-kit";
import { BotOnboarding, exactHttpsOrigin, type CreateConsent } from "./onboarding.js";
import { BotPairings } from "./pairing.js";

/** Public consent endpoints only; signing and bot seeds are never exposed. */
export function createBotAuthorizationServer(manager: BotOnboarding, trustedOwnerOrigin: string) {
  const origin = exactHttpsOrigin(trustedOwnerOrigin);
  const router = new Router({ allowOrigin: origin, exposeErrors: false,
    onError: () => console.error("bot authorization request failed") });
  const limiter = new RateLimiter(30, 60_000);
  const pairings = new BotPairings(raw => manager.pairingIdentity(raw), () => manager.pairingTime());
  const privateHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  let inFlight = 0;
  const route = (operation: "create" | "status" | "confirm" | "cancel") => async ({ raw, params, body }: Parameters<Parameters<Router["post"]>[1]>[0]) => {
    if (raw.headers.origin !== origin) throw new HttpError(403, "untrusted consent origin");
    if (!limiter.allow(clientIp(raw, false))) throw new HttpError(429, "rate limited");
    const header = raw.headers.authorization;
    if (!header?.startsWith("tma ")) throw new HttpError(401, "Telegram authentication required");
    // No authentication values in URLs, cookies, errors, logs or responses.
    const initData = header.slice(4);
    // Refuse overload instead of retaining an unbounded queue of authenticated
    // bodies while an RPC provider is slow. The caller can retry the same ID.
    if (inFlight >= 8) throw new HttpError(503, "consent service busy; retry the same request");
    inFlight += 1;
    try {
      const result = await (async () => {
        if (operation === "create") {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["requestKey", "appId", "home", "sessionExpirySlot", "pairing"].includes(k))) {
            throw new Error("invalid consent request fields");
          }
          const {pairing,...input}=body as CreateConsent & {pairing?:unknown};
          const reference=pairing===undefined?undefined:pairings.authorizeReference(pairing,initData,input);
          const result=await manager.create(initData,input);
          if(reference)pairings.link(reference,initData,result.consent.id);
          return result;
        }
        if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 0)) throw new Error("callback data is not accepted");
        const id = params.id ?? "";
        if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid consent id");
        return manager[operation](initData, id);
      })();
      return { json: result, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } };
    } catch {
      // Do not expose account existence, database errors or authentication material.
      throw new HttpError(403, "consent request refused; authenticate again and check the confirmed permissions");
    } finally { inFlight -= 1; }
  };
  router.post("/requests", route("create"));
  for (const op of ["status", "confirm", "cancel"] as const) router.post(`/requests/:id/${op}`, route(op));
  for (const operation of ["create","claim","status"] as const) {
    const allowed=operation==="claim"?origin:manager.applicationOrigin;
    router.options(`/pairings/${operation}`,async({raw})=>{
      if(raw.headers.origin!==allowed)throw new HttpError(403,"pairing origin refused");
      return {status:204,headers:{...privateHeaders,"access-control-allow-origin":allowed,"access-control-max-age":"0",vary:"Origin"}};
    });
    router.post(`/pairings/${operation}`,async({raw,body,query})=>{
      if(raw.headers.origin!==allowed || query.size)throw new HttpError(403,"pairing origin or URL refused");
      if(!limiter.allow(clientIp(raw,false)))throw new HttpError(429,"rate limited");
      if(inFlight>=8)throw new HttpError(503,"consent service busy");inFlight++;
      const headers={...privateHeaders,"access-control-allow-origin":allowed,vary:"Origin"};
      try {
        if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("invalid pairing body");
        let result:unknown;
        if(operation==="claim") {
          if(Object.keys(body).sort().join(",")!=="claimId,code")throw new Error("invalid claim");
          const b=body as {code:string;claimId:string};result=pairings.claim(b.code,b.claimId);
        } else {
          if(Object.keys(body).join(",")!=="tokenHash"||!raw.headers.authorization?.startsWith("tma "))throw new Error("invalid pairing authentication");
          const initData=raw.headers.authorization.slice(4),tokenHash=(body as {tokenHash:string}).tokenHash;
          if(operation==="create")result=pairings.create(initData,tokenHash);
          else {
            const status=pairings.status(initData,tokenHash);
            if(!status.consentId)result=status;
            else {
              let consent=manager.status(initData,status.consentId);
              if(consent.state==="pending"||consent.state==="confirmed") {
                try {consent=await manager.confirm(initData,status.consentId);} catch {return {json:{state:"unavailable"},headers};}
              }
              result={state:consent.state,consentId:consent.consent.id,pocket:consent.consent.pocket};
            }
          }
        }
        return {json:result,headers};
      } catch {return {status:403,json:{error:"pairing refused; reopen the Mini App and try again"},headers};}
      finally {inFlight--;}
    });
  }
  const server=router.server();server.on("close",()=>pairings.close());return server;
}
