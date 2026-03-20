import { useState, useRef, useEffect, useCallback } from "react";
import { Routes, Route } from "react-router-dom";
import Landing from "./Landing.js";
import SwigPlayground from "./SwigPlayground.js";
import WalletSetup from "./components/WalletSetup.js";
import WalletModal from "./components/WalletModal.js";
import CodeBlock from "./components/CodeBlock.js";
import { ENDPOINTS, buildUrl, buildSnippet } from "./endpoints.js";
import {
  loadSecretKey,
  getBalances,
  getSolBalance,
  requestAirdrop,
  payAndFetch,
  type Step,
  type Balances,
} from "./wallet.js";
import { useWindowWidth } from "./hooks.js";
import type { LogLine, Kind, MobileTab } from "./types.js";

function Playground() {
  const width = useWindowWidth();
  const isMobile = width < 768;

  const [ready, setReady] = useState(!!loadSecretKey());
  const [showWallet, setShowWallet] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("api");
  const [totalRequests, setTotalRequests] = useState(0);
  const [feePayerInfo, setFeePayerInfo] = useState<{
    address: string;
    balance: number;
  } | null>(null);
  const [airdropping, setAirdropping] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const logId = useRef(0);

  const endpoint = ENDPOINTS[selectedIdx];

  const refreshBalance = useCallback(async () => {
    try {
      setBalances(await getBalances());
    } catch {
      /* wallet not ready */
    }
    if (feePayerInfo) {
      try {
        const bal = await getSolBalance(feePayerInfo.address);
        setFeePayerInfo((prev) => (prev ? { ...prev, balance: bal } : prev));
      } catch {
        /* surfpool may be down */
      }
    }
  }, [feePayerInfo]);

  useEffect(() => {
    if (ready) refreshBalance();
  }, [ready, refreshBalance]);

  const addLog = (text: string, kind: Kind) => {
    setLogs((prev) => [...prev, { id: logId.current++, text, kind }]);
    setTimeout(
      () => logRef.current?.scrollTo(0, logRef.current.scrollHeight),
      10,
    );
  };

  const handleSend = async () => {
    if (running) return;
    setRunning(true);
    const url = buildUrl(endpoint, paramValues);

    for await (const step of payAndFetch(url)) {
      switch (step.type) {
        case "request":
          addLog(`${endpoint.method} ${step.url}`, "req");
          break;
        case "challenge":
          if (step.feePayerKey && !feePayerInfo) {
            getSolBalance(step.feePayerKey)
              .then((bal) =>
                setFeePayerInfo({ address: step.feePayerKey!, balance: bal }),
              )
              .catch(() => {});
          }
          const decimals = step.currency === "sol" ? 9 : 6;
          const human = (Number(step.amount) / 10 ** decimals).toFixed(
            decimals === 9 ? 4 : 2,
          );
          addLog(`402 Payment Required: ${human} ${step.currency}`, "402");
          break;
        case "signing":
          addLog("Signing transaction...", "info");
          break;
        case "paying":
          addLog("Sending Solana transaction...", "info");
          break;
        case "confirming":
          addLog(`Confirming: ${step.signature.slice(0, 20)}...`, "dim");
          break;
        case "paid":
          addLog(`Confirmed: ${step.signature.slice(0, 20)}...`, "info");
          break;
        case "success":
          addLog(`${step.status} OK`, "ok");
          addLog(JSON.stringify(step.data, null, 2).slice(0, 500), "dim");
          break;
        case "error":
          addLog(`Error: ${step.message}`, "error");
          break;
      }
    }

    setTotalRequests((n) => n + 1);
    refreshBalance();
    setRunning(false);
  };

  if (!ready) {
    return (
      <WalletSetup
        onReady={() => {
          setReady(true);
          refreshBalance();
        }}
      />
    );
  }

  const kindColor: Record<Kind, string> = {
    req: "#9945FF",
    "402": "#FFD700",
    ok: "#14F195",
    error: "#f88",
    info: "#4FC3F7",
    dim: "#666",
  };

  const sidebar = (
    <div style={s.sidebar}>
      <div style={s.sidebarHeader}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>
          Endpoints
        </span>
        <button style={s.walletBtn} onClick={() => setShowWallet(true)}>
          wallet
        </button>
      </div>
      {ENDPOINTS.map((ep, i) => (
        <button
          key={ep.path}
          style={{
            ...s.epBtn,
            background: i === selectedIdx ? "#1A1A2A" : "transparent",
            borderColor: i === selectedIdx ? "#9945FF" : "#222",
          }}
          onClick={() => {
            setSelectedIdx(i);
            setParamValues({});
          }}
        >
          <span
            style={{
              color: ep.method === "GET" ? "#14F195" : "#FFD700",
              fontSize: 10,
            }}
          >
            {ep.method}
          </span>
          <span style={{ color: "#ccc", fontSize: 12, marginLeft: 8 }}>
            {ep.description}
          </span>
          <span style={{ color: "#666", fontSize: 10, marginLeft: "auto" }}>
            {ep.cost}
          </span>
        </button>
      ))}
      <div style={s.sidebarBottom}>
        {feePayerInfo && (
          <div style={s.balanceSection}>
            <div style={s.balanceLabel}>Fee payer</div>
            <div style={s.balanceRow}>
              <span style={{ color: "#9945FF", fontWeight: 600 }}>
                {feePayerInfo.balance.toFixed(9)}
              </span>
              <span style={{ color: "#666" }}>SOL</span>
            </div>
            <div style={{ color: "#555", fontSize: 9, marginTop: 2 }}>
              {feePayerInfo.address.slice(0, 8)}...
              {feePayerInfo.address.slice(-4)}
            </div>
          </div>
        )}
        <div style={{ ...s.balanceSection, marginTop: 8 }}>
          <div style={s.balanceLabel}>Client</div>
          <div style={s.balanceRow}>
            <span style={{ color: "#14F195", fontWeight: 600 }}>
              {balances !== null ? balances.usdc.toFixed(2) : "—"}
            </span>
            <span style={{ color: "#666" }}>USDC</span>
          </div>
          <div style={s.balanceRow}>
            <span style={{ color: "#888" }}>
              {balances !== null ? balances.sol.toFixed(4) : "—"}
            </span>
            <span style={{ color: "#666" }}>SOL</span>
          </div>
          {balances !== null && balances.usdc === 0 && (
            <button
              style={s.airdropBtn}
              disabled={airdropping}
              onClick={async () => {
                setAirdropping(true);
                try {
                  await requestAirdrop();
                } catch (err) {
                  console.error("Airdrop failed:", err);
                }
                setAirdropping(false);
                refreshBalance();
              }}
            >
              {airdropping ? "Funding..." : "Fund wallet"}
            </button>
          )}
        </div>
        <div style={{ color: "#555", fontSize: 10, marginTop: 8 }}>
          {totalRequests} request{totalRequests !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );

  const apiPanel = (
    <div style={s.apiPanel}>
      <div style={s.apiHeader}>
        <span style={{ color: "#14F195", fontSize: 11 }}>
          {endpoint.method}
        </span>
        <span style={{ color: "#ccc", fontSize: 13, marginLeft: 8 }}>
          {endpoint.path}
        </span>
        <span style={{ color: "#666", fontSize: 11, marginLeft: "auto" }}>
          {endpoint.cost}
        </span>
      </div>
      <div style={s.params}>
        {(endpoint.params ?? []).map((p) => (
          <div
            key={p.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <label style={{ color: "#888", fontSize: 12, minWidth: 60 }}>
              {p.name}
            </label>
            <input
              style={s.input}
              value={paramValues[p.name] ?? p.default}
              onChange={(e) =>
                setParamValues((v) => ({ ...v, [p.name]: e.target.value }))
              }
              placeholder={p.default}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "0 16px 16px" }}>
        <button style={s.sendBtn} onClick={handleSend} disabled={running}>
          {running ? "Sending..." : "Send Request"}
        </button>
        <button
          style={{
            ...s.codeToggle,
            borderColor: showCode ? "#9945FF" : "#333",
          }}
          onClick={() => setShowCode(!showCode)}
        >
          {"</>"}
        </button>
      </div>
      {showCode && (
        <div style={s.codePane}>
          <CodeBlock code={buildSnippet(endpoint, paramValues)} />
        </div>
      )}
    </div>
  );

  const terminal = (
    <div ref={logRef} style={s.terminal}>
      {logs.length === 0 && (
        <div style={{ color: "#444", padding: 16, fontSize: 12 }}>
          Send a request to see the 402 payment flow...
        </div>
      )}
      {logs.map((log) => (
        <div
          key={log.id}
          style={{
            padding: "2px 16px",
            fontSize: 12,
            color: kindColor[log.kind],
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {log.text}
        </div>
      ))}
    </div>
  );

  if (isMobile) {
    return (
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <div style={s.mobileTabs}>
          {(["api", "terminal", "code"] as const).map((tab) => (
            <button
              key={tab}
              style={{
                ...s.mobileTab,
                borderBottomColor:
                  mobileTab === tab ? "#9945FF" : "transparent",
              }}
              onClick={() => setMobileTab(tab)}
            >
              {tab}
            </button>
          ))}
          <button style={s.mobileTab} onClick={() => setShowWallet(true)}>
            {balances !== null ? `${balances.usdc.toFixed(2)}` : "wallet"}
          </button>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {mobileTab === "api" && (
            <>
              {sidebar}
              {apiPanel}
            </>
          )}
          {mobileTab === "terminal" && terminal}
          {mobileTab === "code" && (
            <div style={s.codePane}>
              <CodeBlock code={buildSnippet(endpoint, paramValues)} />
            </div>
          )}
        </div>
        {showWallet && (
          <WalletModal
            onClose={() => setShowWallet(false)}
            onReset={() => setReady(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div style={s.layout}>
      {sidebar}
      <div style={s.main}>
        {apiPanel}
        {terminal}
      </div>
      {showWallet && (
        <WalletModal
          onClose={() => setShowWallet(false)}
          onReset={() => setReady(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/charges" element={<Playground />} />
      <Route path="/sessions" element={<SwigPlayground />} />
    </Routes>
  );
}

const s: Record<string, React.CSSProperties> = {
  layout: {
    display: "flex",
    height: "100vh",
    overflow: "hidden",
  },
  sidebar: {
    width: 280,
    borderRight: "1px solid #222",
    display: "flex",
    flexDirection: "column",
    background: "#0D0D0D",
  },
  sidebarHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 16px 12px",
    borderBottom: "1px solid #222",
  },
  walletBtn: {
    padding: "4px 10px",
    background: "#14F19522",
    border: "1px solid #14F19544",
    borderRadius: 6,
    color: "#14F195",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 11,
    cursor: "pointer",
  },
  epBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    width: "100%",
    padding: "10px 16px",
    background: "transparent",
    border: "1px solid #222",
    borderWidth: "0 0 1px",
    color: "#ccc",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
  },
  sidebarBottom: {
    marginTop: "auto",
    padding: 12,
    borderTop: "1px solid #222",
  },
  balanceSection: {
    padding: 8,
    background: "#0A0A0A",
    borderRadius: 6,
    border: "1px solid #1A1A1A",
  },
  balanceLabel: {
    fontSize: 9,
    color: "#555",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginBottom: 4,
  },
  balanceRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    fontSize: 12,
    lineHeight: 1.6,
  },
  airdropBtn: {
    width: "100%",
    marginTop: 6,
    padding: "6px 0",
    background: "#9945FF22",
    border: "1px solid #9945FF44",
    borderRadius: 4,
    color: "#9945FF",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 10,
    cursor: "pointer",
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  apiPanel: {
    borderBottom: "1px solid #222",
  },
  apiHeader: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: "1px solid #1A1A1A",
  },
  params: {
    padding: 16,
  },
  input: {
    flex: 1,
    padding: "6px 10px",
    background: "#0A0A0A",
    border: "1px solid #222",
    borderRadius: 6,
    color: "#E0E0E0",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 12,
    outline: "none",
  },
  sendBtn: {
    flex: 1,
    padding: "10px 20px",
    background: "#9945FF",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  codeToggle: {
    padding: "10px 14px",
    background: "#1A1A1A",
    border: "1px solid #333",
    borderRadius: 8,
    color: "#E0E0E0",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 13,
    cursor: "pointer",
  },
  codePane: {
    background: "#0A0A0A",
    borderTop: "1px solid #222",
  },
  terminal: {
    flex: 1,
    overflow: "auto",
    background: "#0A0A0A",
    paddingTop: 8,
    paddingBottom: 8,
  },
  mobileTabs: {
    display: "flex",
    borderBottom: "1px solid #222",
    background: "#0D0D0D",
  },
  mobileTab: {
    flex: 1,
    padding: "10px 0",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#888",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    cursor: "pointer",
  },
};
