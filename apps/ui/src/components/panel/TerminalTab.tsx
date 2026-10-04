import { useEffect, useRef, useState } from "react";
import { FitAddon, init, Terminal, type ITheme } from "ghostty-web";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useSessionContext } from "@/components/panel/session-context";
import { WS_BASE } from "@/lib/api";

let initializing: Promise<void> | undefined;

function terminalTheme(host: HTMLElement): ITheme {
  const style = getComputedStyle(host);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  // Ghostty's WASM color parser needs hex/rgb, not the app's oklch tokens.
  const color = (name: string) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = style.getPropertyValue(name).trim();
    ctx.fillRect(0, 0, 1, 1);
    return "#" + Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
      .map((v) => v.toString(16).padStart(2, "0")).join("");
  };
  return {
    background: color("--background"), foreground: color("--foreground"),
    cursor: color("--foreground"), cursorAccent: color("--background"),
    selectionBackground: color("--secondary"), selectionForeground: color("--foreground"),
    black: color("--terminal-black"), brightBlack: color("--muted-foreground"),
    white: color("--terminal-white"), brightWhite: color("--terminal-bright-white"),
    red: color("--terminal-red"), brightRed: color("--terminal-bright-red"),
    green: color("--terminal-green"), brightGreen: color("--terminal-bright-green"),
    yellow: color("--terminal-yellow"), brightYellow: color("--terminal-bright-yellow"),
    blue: color("--terminal-blue"), brightBlue: color("--terminal-bright-blue"),
    magenta: color("--terminal-magenta"), brightMagenta: color("--terminal-bright-magenta"),
    cyan: color("--terminal-cyan"), brightCyan: color("--terminal-bright-cyan"),
  };
}

export function TerminalTab() {
  const { sessionId } = useSessionContext();
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");
  const [nonce, setNonce] = useState(0);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current!;
    let disposed = false;
    let loaded = false;
    let terminal: Terminal | undefined;
    let fit: FitAddon | undefined;
    let socket: WebSocket | undefined;
    let ready = false;
    let attempts = 0;
    let frame = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();

    const sendResize = () => {
      if (ready && socket?.readyState === WebSocket.OPEN && terminal) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };

    const connect = () => {
      if (disposed) return;
      ready = false;
      // Raw PTY bytes with its own backoff and give-up, so not the shared client's reconnecting socket.
      const ws = new WebSocket(`${WS_BASE}/api/session/${sessionId}/terminal`);
      ws.binaryType = "arraybuffer";
      socket = ws;
      let ended = false;
      // The SDK replays the PTY buffer on reconnect; don't append it twice.
      terminal!.reset();
      setStatus(attempts ? "Reconnecting…" : "Connecting…");
      ws.onmessage = ({ data }) => {
        if (disposed || socket !== ws) return;
        if (data instanceof ArrayBuffer) {
          terminal!.write(new Uint8Array(data));
          return;
        }
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (message.type === "ready") {
          ready = true;
          attempts = 0;
          setStatus("Connected");
          sendResize();
        } else if (message.type === "error" || message.type === "exit") {
          ended = true;
          ready = false;
          setStatus(message.type === "exit" ? `Shell exited (${message.code})` : (message.message || "Terminal error"));
          ws.close();
        }
      };
      ws.onclose = () => {
        if (disposed || socket !== ws) return;
        ready = false;
        if (ended) return;
        if (attempts >= 10) {
          setStatus("Disconnected — reconnect to try again");
          return;
        }
        const delay = Math.min(1000 * 2 ** attempts++, 30000);
        setStatus(`Disconnected — reconnecting in ${delay / 1000}s…`);
        retry = setTimeout(connect, delay);
      };
      ws.onerror = () => { /* The close event schedules reconnect. */ };
    };

    const layout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !loaded || !host.isConnected || host.clientWidth < 40 || host.clientHeight < 40) return;
        if (!terminal) {
          terminal = new Terminal({
            cols: 80, rows: 24, cursorBlink: true, cursorStyle: "bar", scrollback: 10000,
            fontSize: 12, fontFamily: getComputedStyle(host).getPropertyValue("--font-jetbrains-mono").trim(),
            theme: terminalTheme(host),
          });
          fit = new FitAddon();
          terminal.loadAddon(fit);
          terminal.open(host);
          terminal.onData((data) => {
            if (ready && socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
          });
          terminal.onResize(sendResize);
          fit.fit();
          connect();
        } else {
          fit!.fit();
        }
        // Trellis can reattach a canvas without changing its cell dimensions.
        // Fit alone then does nothing; force a redraw after the layout settles.
        if (terminal.wasmTerm) terminal.renderer?.render(terminal.wasmTerm, true, terminal.getViewportY(), terminal);
      });
    };
    const observer = new ResizeObserver(layout);
    observer.observe(host);
    initializing ??= init();
    Promise.all([initializing, document.fonts.load('12px "JetBrains Mono Variable"')]).then(() => {
      if (disposed) return;
      loaded = true;
      layout();
    }).catch((e: Error) => { if (!disposed) setStatus(`Terminal failed: ${e.message}`); });

    return () => {
      disposed = true;
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (socket) {
        socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close();
      }
      terminal?.dispose();
      host.replaceChildren();
    };
    // 0.4.0 cannot update WASM theme colors in place. Recreate the renderer
    // and reattach to the same server shell when the app switches themes.
  }, [sessionId, dark, nonce]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span role="status" className="min-w-0 flex-1 truncate" title={status}>{status}</span>
        <button type="button" aria-label="Reconnect terminal" title="Reconnect terminal"
          onClick={() => setNonce((n) => n + 1)} className="rounded-md p-1 hover:bg-muted hover:text-foreground">
          <ArrowClockwiseIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div ref={hostRef} className="h-full w-full overflow-hidden" aria-label="Sandbox terminal" />
      </div>
    </div>
  );
}
