import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css?inline";
import type { ModuleProps } from "module-core";
import { useUserProfile } from "module-core";
import { encodeText, getSerialRuntime } from "web-serial-runtime";
import type {
  SerialOpenOptions,
  SerialPortInfo,
  SerialPortId,
} from "web-serial-runtime";

type LineEnding = "none" | "lf" | "crlf";

const C = {
  bg: "var(--hep-bg, var(--color-bg, #080f1c))",
  panel: "var(--hep-surface, var(--color-surface, #0b1525))",
  panel2: "var(--hep-surface-raised, var(--color-surface-raised, #0d1a2e))",
  input: "var(--hep-input-bg, #0a1525)",
  border: "var(--hep-border, var(--color-border, #1a2a42))",
  text: "var(--hep-text, var(--color-text, #e5e7eb))",
  muted: "var(--hep-muted, var(--color-muted, #6b7280))",
  accent: "var(--hep-accent, var(--color-primary, #3b82f6))",
  accentText: "var(--hep-accent-text, var(--color-primary-contrast, #ffffff))",
  warning: "var(--hep-warning, #f59e0b)",
  danger: "var(--hep-danger, #ef4444)",
  ok: "var(--hep-success, #22c55e)",
};

const BAUD_PRESETS = [115200, 921600, 57600, 38400, 230400];

function describePort(port: SerialPortInfo): string {
  const vendor = port.usbVendorId?.toString(16).padStart(4, "0");
  const product = port.usbProductId?.toString(16).padStart(4, "0");
  return vendor || product ? `${vendor ?? "????"}:${product ?? "????"}` : "unknown usb";
}

function portSuffix(port: SerialPortInfo): string {
  const parts = port.id.split("-");
  if (parts.length >= 3) {
    return parts[1] ?? port.id.slice(-6);
  }
  return port.id.slice(0, 8);
}

function portGroupBase(port: SerialPortInfo): string {
  return `${port.usbVendorId?.toString(16).padStart(4, "0") ?? "????"}:${port.usbProductId?.toString(16).padStart(4, "0") ?? "????"}`;
}

function toAlpha(index: number): string {
  let value = index;
  let result = "";
  do {
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

type PortDisplayInfo = {
  portId: SerialPortId;
  aliasKey: string;
  defaultLabel: string;
  detailLabel: string;
};

type LocalSerialSettings = {
  aliases?: Record<string, string>;
  baudRates?: Record<string, number>;
};

function buildPortDisplayMap(ports: SerialPortInfo[]): Record<string, PortDisplayInfo> {
  const grouped = new Map<string, SerialPortInfo[]>();
  for (const port of ports) {
    const key = portGroupBase(port);
    const group = grouped.get(key) ?? [];
    group.push(port);
    grouped.set(key, group);
  }

  const result: Record<string, PortDisplayInfo> = {};
  let deviceIndex = 1;
  for (const [, group] of grouped) {
    const isMultiPort = group.length > 1;
    group.forEach((port, index) => {
      const suffix = isMultiPort ? `-${toAlpha(index)}` : "";
      const defaultLabel = `${deviceIndex}${suffix}`;
      result[port.id] = {
        portId: port.id,
        aliasKey: `${portGroupBase(port)}#${index + 1}`,
        defaultLabel,
        detailLabel: `${defaultLabel} | ${describePort(port)} | id ${portSuffix(port)}`,
      };
    });
    deviceIndex += 1;
  }

  return result;
}

function getLocalSettingsStorageKey(config: ModuleProps["config"]): string {
  const params = new URLSearchParams(window.location.search);
  const bucket = params.get("bucket") ?? "local";
  const configPath = params.get("config") ?? "config";
  return `hep:serial-display:settings:${bucket}:${configPath}:${config.id}`;
}

function readLocalSettings(config: ModuleProps["config"]): LocalSerialSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(getLocalSettingsStorageKey(config));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as LocalSerialSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalSettings(config: ModuleProps["config"], settings: LocalSerialSettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(getLocalSettingsStorageKey(config), JSON.stringify(settings));
}

function selectedBaud(config: ModuleProps["config"]): number {
  const value = Number(config.meta?.["baudRate"] ?? 115200);
  return Number.isFinite(value) && value > 0 ? value : 115200;
}

export default function SerialDisplay({ config }: ModuleProps) {
  const runtime = useMemo(() => getSerialRuntime(), []);
  const user = useUserProfile();
  const claimantId = useMemo(
    () => `${config.id}:${user?.email ?? "anonymous"}`,
    [config.id, user?.email]
  );
  const initialLocalSettings = useMemo(() => readLocalSettings(config), [config]);

  const [ports, setPorts] = useState<SerialPortInfo[]>(() => runtime.listPorts());
  const [selectedPortId, setSelectedPortId] = useState<SerialPortId | null>(null);
  const [command, setCommand] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [baudRate, setBaudRate] = useState<number>(selectedBaud(config));
  const [lineEnding, setLineEnding] = useState<LineEnding>("lf");
  const [autoScroll, setAutoScroll] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [statusText, setStatusText] = useState("Ready.");
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const sessionBuffersRef = useRef<Record<string, string>>({});
  const selectedPortIdRef = useRef<SerialPortId | null>(null);
  const [aliasMap, setAliasMap] = useState<Record<string, string>>(initialLocalSettings.aliases ?? {});
  const [baudMap, setBaudMap] = useState<Record<string, number>>(initialLocalSettings.baudRates ?? {});
  const displayMap = useMemo(() => buildPortDisplayMap(ports), [ports]);

  const selectedPort =
    ports.find((port) => port.id === selectedPortId) ?? null;
  const selectedDisplay = selectedPort ? displayMap[selectedPort.id] : undefined;
  const canWrite =
    !!selectedPort &&
    selectedPort.state === "open" &&
    selectedPort.claimedBy === claimantId;

  const renderSelectedSession = useCallback(() => {
    const terminal = terminalRef.current;
    const currentPortId = selectedPortIdRef.current;
    if (!terminal) return;
    terminal.reset();
    if (!currentPortId) {
      terminal.writeln("\x1b[90mSelect a port to view its session.\x1b[0m");
      return;
    }
    const transcript = sessionBuffersRef.current[currentPortId] ?? "";
    if (transcript) {
      terminal.write(transcript);
    } else {
      terminal.writeln("\x1b[90mNo session output for this port yet.\x1b[0m");
    }
    if (autoScroll) {
      terminal.scrollToBottom();
    }
  }, [autoScroll]);

  const appendToSession = useCallback((portId: SerialPortId, text: string) => {
    const existing = sessionBuffersRef.current[portId] ?? "";
    const next = `${existing}${text}`;
    sessionBuffersRef.current[portId] =
      next.length > 250000 ? next.slice(next.length - 250000) : next;

    if (selectedPortIdRef.current === portId) {
      terminalRef.current?.write(text);
      if (autoScroll) {
        terminalRef.current?.scrollToBottom();
      }
    }
  }, [autoScroll]);

  useEffect(() => {
    selectedPortIdRef.current = selectedPortId;
  }, [selectedPortId]);

  useEffect(() => {
    if (!selectedPortId) {
      setBaudRate(selectedBaud(config));
      return;
    }
    const display = displayMap[selectedPortId];
    const persistedBaud = display ? baudMap[display.aliasKey] : undefined;
    setBaudRate(persistedBaud ?? selectedBaud(config));
  }, [baudMap, config, displayMap, selectedPortId]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById("hep-xterm-css")) return;
    const style = document.createElement("style");
    style.id = "hep-xterm-css";
    style.textContent = xtermCss;
    document.head.appendChild(style);
  }, []);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    const computed = getComputedStyle(host);
    const themeColor = (name: string, fallback: string) =>
      computed.getPropertyValue(name).trim() || fallback;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: "Consolas, Menlo, Monaco, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: themeColor("--hep-bg", "#080f1c"),
        foreground: themeColor("--hep-text", "#e5e7eb"),
        cursor: themeColor("--hep-text", "#e5e7eb"),
        cursorAccent: themeColor("--hep-bg", "#080f1c"),
        selectionBackground: "rgba(96, 165, 250, 0.35)",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    renderSelectedSession();

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(host);

    const handleWindowResize = () => fitAddon.fit();
    window.addEventListener("resize", handleWindowResize);

    return () => {
      window.removeEventListener("resize", handleWindowResize);
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [renderSelectedSession]);

  useEffect(() => {
    const unsubscribe = runtime.subscribePorts((next: SerialPortInfo[]) => {
      setPorts(next);
      setSelectedPortId((current: SerialPortId | null) => {
        if (current && next.some((port: SerialPortInfo) => port.id === current)) return current;
        return next[0]?.id ?? null;
      });
    });
    void runtime.refreshPorts().catch(() => undefined);
    return unsubscribe;
  }, [runtime]);

  useEffect(() => {
    if (isEditingLabel) return;
    if (!selectedPort) {
      setLabelDraft("");
      return;
    }
    const alias = selectedDisplay ? aliasMap[selectedDisplay.aliasKey] : "";
    setLabelDraft(alias || selectedDisplay?.defaultLabel || "");
  }, [aliasMap, isEditingLabel, selectedDisplay, selectedPort?.id]);

  useEffect(() => {
    for (const port of ports) {
      const display = displayMap[port.id];
      if (!display) continue;
      const alias = aliasMap[display.aliasKey];
      const nextLabel = alias || display.defaultLabel;
      if (port.label !== nextLabel) {
        runtime.setPortLabel(port.id, nextLabel);
      }
    }
  }, [aliasMap, displayMap, ports, runtime]);

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];

    for (const port of ports) {
      unsubscribers.push(runtime.subscribeText(port.id, (text) => {
        appendToSession(port.id, text);
      }));
      unsubscribers.push(runtime.subscribeEvents(port.id, (event) => {
        if (event.type === "error") {
          appendToSession(event.port.id, `\r\n\x1b[31m${event.port.label}: ${event.error.message}\x1b[0m\r\n`);
          if (selectedPortIdRef.current === event.port.id) {
            setStatusText(`${event.port.label}: ${event.error.message} (attempting recovery)`);
          }
          return;
        }
        if (selectedPortIdRef.current !== event.port.id) return;
        if (event.type === "claimed") {
          setStatusText(`${event.port.label} claimed by ${event.claimant}`);
          return;
        }
        if (event.type === "released") {
          setStatusText(`${event.port.label} released by ${event.claimant}`);
          return;
        }
        setStatusText(`${event.port.label} is now ${event.port.state}`);
      }));
    }

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [appendToSession, ports, runtime]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !selectedPortId) return;

    let disposed = false;
    let pendingWrite = Promise.resolve();
    const terminalInput = terminal.onData((data) => {
      if (!canWrite || disposed) return;
      pendingWrite = pendingWrite
        .then(() => runtime.write(selectedPortId, encodeText(data), claimantId))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setStatusText(message);
        });
    });

    return () => {
      disposed = true;
      terminalInput.dispose();
    };
  }, [canWrite, claimantId, runtime, selectedPortId]);

  useEffect(() => {
    renderSelectedSession();
  }, [renderSelectedSession, selectedPortId]);

  useEffect(() => {
    return () => {
      for (const port of runtime.listPorts()) {
        if (port.claimedBy === claimantId) {
          void runtime.releasePort(port.id, claimantId).catch(() => undefined);
        }
      }
    };
  }, [claimantId, runtime]);

  const refreshPorts = useCallback(async () => {
    setIsBusy(true);
    try {
      const next = await runtime.refreshPorts();
      setStatusText(`Found ${next.length} granted serial port${next.length === 1 ? "" : "s"}.`);
    } catch (error: unknown) {
      setStatusText((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }, [runtime]);

  const requestPort = useCallback(async () => {
    setIsBusy(true);
    try {
      const port = await runtime.requestPort();
      if (port) {
        setSelectedPortId(port.id);
        setStatusText(`Granted access to ${port.label}.`);
        appendToSession(port.id, `\x1b[90mGranted access to ${port.label}.\x1b[0m\r\n`);
      }
    } catch (error: unknown) {
      setStatusText((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }, [runtime]);

  const connectPort = useCallback(async () => {
    if (!selectedPortId) return;
    setIsBusy(true);
    try {
      const options: SerialOpenOptions = { baudRate, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" };
      await runtime.claimPort(selectedPortId, claimantId, options);
      if (selectedPort?.state === "error" || selectedPort?.state === "disconnected") {
        await runtime.closePort(selectedPortId, claimantId).catch(() => undefined);
      }
      await runtime.openPort(selectedPortId, options, claimantId);
      setStatusText(`Opened ${selectedPort?.label ?? selectedPortId} at ${baudRate}. Click the terminal to type.`);
      appendToSession(selectedPortId, `\x1b[90mOpened ${selectedPort?.label ?? selectedPortId} at ${baudRate}.\x1b[0m\r\n`);
      terminalRef.current?.focus();
      fitAddonRef.current?.fit();
    } catch (error: unknown) {
      setStatusText((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }, [baudRate, claimantId, runtime, selectedPort?.label, selectedPortId]);

  const disconnectPort = useCallback(async () => {
    if (!selectedPortId) return;
    setIsBusy(true);
    try {
      await runtime.closePort(selectedPortId, claimantId);
      await runtime.releasePort(selectedPortId, claimantId);
      setStatusText(`Closed ${selectedPort?.label ?? selectedPortId}.`);
      appendToSession(selectedPortId, `\r\n\x1b[90mClosed ${selectedPort?.label ?? selectedPortId}.\x1b[0m\r\n`);
    } catch (error: unknown) {
      setStatusText((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }, [claimantId, runtime, selectedPort?.label, selectedPortId]);

  const saveLabel = useCallback(() => {
    if (!selectedPortId) return;
    const display = displayMap[selectedPortId];
    if (!display) return;
    const trimmed = labelDraft.trim();
    const nextAliases = { ...aliasMap };

    if (!trimmed || trimmed === display.defaultLabel) {
      delete nextAliases[display.aliasKey];
      runtime.setPortLabel(selectedPortId, display.defaultLabel);
      setAliasMap(nextAliases);
      writeLocalSettings(config, { aliases: nextAliases, baudRates: baudMap });
      setStatusText(`Cleared custom label for ${display.defaultLabel}.`);
      setLabelDraft(display.defaultLabel);
    } else {
      nextAliases[display.aliasKey] = trimmed;
      runtime.setPortLabel(selectedPortId, trimmed);
      setAliasMap(nextAliases);
      writeLocalSettings(config, { aliases: nextAliases, baudRates: baudMap });
      setStatusText(`Renamed port to "${trimmed}".`);
      setLabelDraft(trimmed);
    }
  }, [aliasMap, baudMap, config, displayMap, labelDraft, runtime, selectedPortId]);

  const handleBaudRateChange = useCallback((nextBaud: number) => {
    setBaudRate(nextBaud);
    if (!selectedPortId) return;
    const display = displayMap[selectedPortId];
    if (!display) return;
    const nextBaudMap = { ...baudMap, [display.aliasKey]: nextBaud };
    setBaudMap(nextBaudMap);
    writeLocalSettings(config, { aliases: aliasMap, baudRates: nextBaudMap });
  }, [aliasMap, baudMap, config, displayMap, selectedPortId]);

  const sendCommand = useCallback(async () => {
    if (!selectedPortId || !command.trim()) return;
    let payload = command;
    if (lineEnding === "lf") payload += "\n";
    if (lineEnding === "crlf") payload += "\r\n";

    setIsBusy(true);
    try {
      await runtime.write(selectedPortId, encodeText(payload), claimantId);
      setStatusText(`Sent ${payload.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`);
      appendToSession(selectedPortId, payload);
      setCommand("");
      terminalRef.current?.focus();
    } catch (error: unknown) {
      setStatusText((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }, [claimantId, command, lineEnding, runtime, selectedPortId]);

  const clearTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal || !selectedPortId) return;
    sessionBuffersRef.current[selectedPortId] = "";
    renderSelectedSession();
    setStatusText("Terminal cleared.");
  }, [renderSelectedSession, selectedPortId]);

  if (!runtime.isSupported()) {
    return (
      <div style={centeredStyle()}>
        Web Serial is not available in this browser.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <aside style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, background: C.panel }}>
        <div style={{ padding: "1rem", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: "0.72rem", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Serial Display</div>
          <div style={{ marginTop: "0.25rem", fontSize: "0.95rem", fontWeight: 600 }}>{(config.meta?.["title"] as string | undefined) ?? "Serial Console"}</div>
        </div>

        <div style={{ padding: "0.85rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", borderBottom: `1px solid ${C.border}` }}>
          <button onClick={() => void refreshPorts()} disabled={isBusy} style={ghostButton()}>Refresh</button>
          <button onClick={() => void requestPort()} disabled={isBusy} style={primaryButton()}>Request Port</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0.65rem" }}>
          {ports.length === 0 ? (
            <p style={{ margin: 0, padding: "0.35rem", color: C.muted, fontSize: "0.82rem" }}>No granted ports yet.</p>
          ) : (
            ports.map((port) => {
              const selected = port.id === selectedPortId;
              const claimedByOther = !!port.claimedBy && port.claimedBy !== claimantId;
              const display = displayMap[port.id];
              const alias = display ? aliasMap[display.aliasKey] : "";
              const displayName = alias || display?.defaultLabel || port.id;
              return (
                <button
                  key={port.id}
                  onClick={() => setSelectedPortId(port.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: `1px solid ${selected ? C.accent : C.border}`,
                    background: selected ? C.panel2 : "transparent",
                    color: C.text,
                    borderRadius: 8,
                    padding: "0.65rem 0.75rem",
                    marginBottom: "0.5rem",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                    <strong style={{ fontSize: "0.86rem" }}>{displayName}</strong>
                    <StatusBadge port={port} claimantId={claimantId} />
                  </div>
                  <div style={{ marginTop: "0.28rem", color: C.muted, fontSize: "0.75rem" }}>
                    {display?.detailLabel ?? `${describePort(port)} | id ${portSuffix(port)}`}
                  </div>
                  {claimedByOther ? (
                    <div style={{ marginTop: "0.28rem", color: C.warning, fontSize: "0.74rem" }}>Owned by {port.claimedBy}</div>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "0.85rem 1rem", borderBottom: `1px solid ${C.border}`, background: C.panel2, display: "grid", gridTemplateColumns: "1.3fr 0.8fr 0.8fr auto auto", gap: "0.6rem", alignItems: "end" }}>
          <label style={labelStyle()}>
            Port Label
            <input
              ref={labelInputRef}
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
              onFocus={() => setIsEditingLabel(true)}
              onBlur={() => {
                setIsEditingLabel(false);
                saveLabel();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setIsEditingLabel(false);
                  saveLabel();
                  labelInputRef.current?.blur();
                }
              }}
              style={inputStyle()}
              disabled={!selectedPort}
            />
          </label>
          <label style={labelStyle()}>
            Baud
            <select value={String(baudRate)} onChange={(event) => handleBaudRateChange(Number(event.target.value))} style={inputStyle()} disabled={!selectedPort}>
              {BAUD_PRESETS.map((preset) => (
                <option key={preset} value={preset}>{preset}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle()}>
            State
            <div style={{ ...readoutStyle(), color: selectedPort?.state === "open" ? C.ok : C.muted }}>
              {selectedPort?.state ?? "none"}
            </div>
          </label>
          <button
            onClick={() => void connectPort()}
            disabled={!selectedPort || isBusy || selectedPort.state === "open"}
            style={!selectedPort || isBusy || selectedPort.state === "open" ? disabledButtonStyle() : primaryButton()}
          >
            Connect
          </button>
          <button
            onClick={() => void disconnectPort()}
            disabled={!selectedPort || isBusy || selectedPort.state !== "open"}
            style={!selectedPort || isBusy || selectedPort.state !== "open" ? disabledButtonStyle() : ghostButton()}
          >
            Disconnect
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            background: C.bg,
            padding: "0.5rem",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            ref={terminalHostRef}
            onClick={() => terminalRef.current?.focus()}
            style={{
              flex: 1,
              minHeight: 0,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              overflow: "hidden",
              background: C.bg,
            }}
          />
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, padding: "0.85rem 1rem", background: C.panel, display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "0.6rem", alignItems: "end" }}>
          <label style={labelStyle()}>
            Command
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendCommand();
                }
              }}
              placeholder={canWrite ? "Type a command or click the terminal to type interactively" : "Connect and claim a port to send commands"}
              disabled={!canWrite}
              style={inputStyle()}
            />
          </label>
          <label style={labelStyle()}>
            Line End
            <select value={lineEnding} onChange={(event) => setLineEnding(event.target.value as LineEnding)} style={inputStyle()}>
              <option value="none">None</option>
              <option value="lf">LF</option>
              <option value="crlf">CRLF</option>
            </select>
          </label>
          <button onClick={clearTerminal} style={ghostButton()}>Clear</button>
          <button onClick={() => void sendCommand()} disabled={!canWrite || !command.trim() || isBusy} style={primaryButton()}>
            Send
          </button>
        </div>

        <div style={{ padding: "0.45rem 1rem", borderTop: `1px solid ${C.border}`, fontSize: "0.76rem", color: C.muted, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", background: C.panel2 }}>
          <span>
            {selectedPort
              ? `${(selectedDisplay ? aliasMap[selectedDisplay.aliasKey] || selectedDisplay.defaultLabel : selectedPort.label)} | ${describePort(selectedPort)} | ${statusText}`
              : "Select a granted port to begin"}
          </span>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
            <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
            Auto-scroll
          </label>
        </div>
      </section>
    </div>
  );
}

function StatusBadge({
  port,
  claimantId,
}: {
  port: SerialPortInfo;
  claimantId: string;
}) {
  const color =
    port.state === "open"
      ? port.claimedBy && port.claimedBy !== claimantId
        ? C.warning
        : C.ok
      : port.state === "error"
        ? C.danger
        : C.muted;
  const label =
    port.state === "open"
      ? port.claimedBy === claimantId
        ? "owned"
        : "observing"
      : port.state;

  return (
    <span style={{ border: `1px solid ${color}`, color, borderRadius: 999, padding: "0.1rem 0.45rem", fontSize: "0.68rem", fontWeight: 700 }}>
      {label}
    </span>
  );
}

function centeredStyle(): React.CSSProperties {
  return {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: C.bg,
    color: C.muted,
    fontFamily: "system-ui, -apple-system, sans-serif",
  };
}

function labelStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "0.35rem",
    color: C.muted,
    fontSize: "0.74rem",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontWeight: 700,
  };
}

function readoutStyle(): React.CSSProperties {
  return {
    minHeight: 38,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    padding: "0.5rem 0.65rem",
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    background: C.input,
    fontSize: "0.84rem",
    textTransform: "none",
    letterSpacing: 0,
    fontWeight: 500,
  };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    background: C.input,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    color: C.text,
    padding: "0.52rem 0.65rem",
    outline: "none",
    font: "inherit",
  };
}

function primaryButton(): React.CSSProperties {
  return {
    border: `1px solid ${C.accent}`,
    borderRadius: 6,
    background: C.accent,
    color: C.accentText,
    padding: "0.52rem 0.85rem",
    cursor: "pointer",
    fontWeight: 600,
    fontFamily: "inherit",
  };
}

function ghostButton(): React.CSSProperties {
  return {
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    background: "transparent",
    color: C.text,
    padding: "0.52rem 0.85rem",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function disabledButtonStyle(): React.CSSProperties {
  return {
    ...ghostButton(),
    opacity: 0.45,
    cursor: "not-allowed",
  };
}
