/**
 * EIP-6963 multi-wallet discovery (no wagmi, no WalletConnect project id needed).
 * Carried over from the legacy terminal's wallet connector: prefer MetaMask, then any announced
 * wallet, then a legacy injected provider; human error messages for the common failure codes.
 */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type DiscoveredWallet = { info: WalletInfo; provider: Eip1193Provider };

export const METAMASK_RDNS = "io.metamask";
export const CONNECT_TIMEOUT_MS = 30_000;

type AnnounceEvent = CustomEvent<DiscoveredWallet>;

/** Starts EIP-6963 discovery. Calls `onChange` with the deduplicated wallet list; returns a cleanup. */
export function discoverWallets(onChange: (wallets: DiscoveredWallet[]) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const found = new Map<string, DiscoveredWallet>();
  const emit = () => onChange(sortWallets([...found.values()]));
  const onAnnounce = (event: Event) => {
    const detail = (event as AnnounceEvent).detail;
    if (!detail?.info?.uuid || !detail.provider) return;
    found.set(detail.info.uuid, detail);
    emit();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const legacy = (window as unknown as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
  const fallbackTimer = window.setTimeout(() => {
    if (found.size === 0 && legacy) {
      found.set("legacy-injected", {
        info: { uuid: "legacy-injected", name: legacy.isMetaMask ? "MetaMask" : "Browser wallet", icon: "", rdns: legacy.isMetaMask ? METAMASK_RDNS : "injected" },
        provider: legacy,
      });
      emit();
    }
  }, 400);
  return () => {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    window.clearTimeout(fallbackTimer);
  };
}

/** MetaMask first, then other EIP-6963 wallets alphabetically, legacy injected last. */
export function sortWallets(wallets: DiscoveredWallet[]): DiscoveredWallet[] {
  const rank = (w: DiscoveredWallet) => (w.info.rdns === METAMASK_RDNS ? 0 : w.info.uuid === "legacy-injected" ? 2 : 1);
  return [...wallets].sort((a, b) => rank(a) - rank(b) || a.info.name.localeCompare(b.info.name));
}

function codeOf(error: unknown): number | null {
  let v: unknown = error;
  for (let depth = 0; depth < 6 && v && typeof v === "object"; depth += 1) {
    const code = (v as { code?: unknown }).code;
    if (typeof code === "number") return code;
    v = (v as { cause?: unknown }).cause;
  }
  return null;
}

export function connectErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "ConnectTimeoutError") return "No response from the wallet. Open it to approve, then try again.";
  const code = codeOf(error);
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (code === 4001 || /user rejected|user denied/i.test(text)) return "Request rejected in the wallet.";
  if (code === -32002 || /already pending/i.test(text)) return "A wallet request is already pending. Open the wallet to answer it.";
  if (code === 4902) return "This network is not in your wallet yet.";
  return "Could not connect. Try again.";
}

export function withTimeout<T>(promise: Promise<T>, ms = CONNECT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error("Connection timed out.");
      e.name = "ConnectTimeoutError";
      reject(e);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function requestAccounts(provider: Eip1193Provider): Promise<string[]> {
  return (await withTimeout(provider.request({ method: "eth_requestAccounts" }))) as string[];
}

export async function walletChainId(provider: Eip1193Provider): Promise<number> {
  return Number.parseInt(String(await provider.request({ method: "eth_chainId" })), 16);
}

/** Switches the wallet to `chainId`, adding the network first when the wallet does not know it. */
export async function switchToChain(provider: Eip1193Provider, chain: { id: number; name: string; rpcUrl: string | null; explorerUrl: string | null }): Promise<void> {
  const hex = `0x${chain.id.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (error) {
    if (codeOf(error) !== 4902 || !chain.rpcUrl) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [chain.rpcUrl],
          blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : [],
        },
      ],
    });
  }
}
