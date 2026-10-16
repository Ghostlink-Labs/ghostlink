/**
 * React bindings for GhostLink. An app wraps itself in
 * <GhostLinkProvider>, reads state through useGhostLink(), and drops
 * <ContinueWithGhostLink> next to its old connect button.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  GhostLink,
  type GhostLinkConfig,
  type GhostLinkSession,
} from "@ghostlink/sdk";

export interface GhostLinkContextValue {
  client: GhostLink | null;
  session: GhostLinkSession | null;
  status: "idle" | "initializing" | "proving" | "ready" | "error";
  error: string | null;
  setSession: (s: GhostLinkSession | null) => void;
}

const Ctx = createContext<GhostLinkContextValue>({
  client: null,
  session: null,
  status: "idle",
  error: null,
  setSession: () => undefined,
});

export interface GhostLinkProviderProps {
  /**
   * Configuration for this provider's lifetime. To change cluster,
   * endpoints, origin or prover, remount the provider using a different
   * React key so the previous client and session are discarded together.
   */
  config: GhostLinkConfig;
  children: ReactNode;
}

export function GhostLinkProvider({ config, children }: GhostLinkProviderProps) {
  const [initialConfig] = useState(config);
  const [client, setClient] = useState<GhostLink | null>(null);
  const [session, setSession] = useState<GhostLinkSession | null>(null);
  const [status, setStatus] = useState<GhostLinkContextValue["status"]>("idle");
  const [error, setError] = useState<string | null>(null);

  const ensureClient = useCallback(async () => {
    if (client) return client;
    setStatus("initializing");
    try {
      const c = await GhostLink.init(initialConfig);
      setClient(c);
      setStatus("ready");
      return c;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
      throw e;
    }
  }, [client, initialConfig]);

  const value = useMemo<GhostLinkContextValue & { ensureClient: typeof ensureClient }>(
    () => ({ client, session, status, error, setSession, ensureClient }),
    [client, session, status, error, ensureClient],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGhostLink(): GhostLinkContextValue {
  return useContext(Ctx);
}

export interface ContinueWithGhostLinkProps {
  /** Called when the user taps the button; the app runs its login flow
   * (gather witness data, prove, send the proof to its backend) and
   * resolves with the session, which the provider then exposes. */
  onLogin: (client: GhostLink) => Promise<GhostLinkSession>;
  label?: string;
  className?: string;
}

export function ContinueWithGhostLink({
  onLogin,
  label = "Continue with GhostLink",
  className,
}: ContinueWithGhostLinkProps) {
  const ctx = useContext(Ctx) as GhostLinkContextValue & {
    ensureClient?: () => Promise<GhostLink>;
  };
  const [busy, setBusy] = useState(false);

  const [failure, setFailure] = useState<string | null>(null);

  const click = useCallback(async () => {
    if (busy || !ctx.ensureClient) return;
    setBusy(true);
    setFailure(null);
    try {
      const client = await ctx.ensureClient();
      const session = await onLogin(client);
      ctx.setSession(session);
    } catch (e) {
      // A refused wallet or a failed proof is the user's to see, not an
      // unhandled rejection in the console.
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, ctx, onLogin]);

  return (
    <>
      <button type="button" className={className} onClick={click} disabled={busy}>
        {busy ? "Proving…" : label}
      </button>
      {failure && (
        <span role="alert" style={{ display: "block", marginTop: 8, fontSize: 13 }}>
          {failure}
        </span>
      )}
    </>
  );
}
