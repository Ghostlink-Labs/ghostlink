import { HttpError, RateLimiter, Router, clientIp } from "@ghostlink/service-kit";
import { BotOnboarding, exactHttpsOrigin, type CreateConsent } from "./onboarding.js";

/** Public consent endpoints only; signing and bot seeds are never exposed. */
export function createBotAuthorizationServer(manager: BotOnboarding, trustedOwnerOrigin: string) {
  const origin = exactHttpsOrigin(trustedOwnerOrigin);
  const router = new Router({ allowOrigin: origin, exposeErrors: false,
    onError: () => console.error("bot authorization request failed") });
  const limiter = new RateLimiter(30, 60_000);
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
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["requestKey", "appId", "home", "sessionExpirySlot"].includes(k))) {
            throw new Error("invalid consent request fields");
          }
          return manager.create(initData, body as CreateConsent);
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
  return router.server();
}
