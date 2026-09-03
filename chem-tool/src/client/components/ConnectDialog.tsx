import { useEffect, useState } from 'react';

interface ConnectInfo { mcpUrl: string; claudeCode: string; openapi: string; window: string }

function Snippet({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <div className="snippet-label">{label}</div>
      <pre>{value}</pre>
      <button onClick={() => { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'copied' : 'copy'}</button>
    </div>
  );
}

export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  useEffect(() => { if (open) fetch('/api/connect').then((r) => r.json()).then(setInfo).catch(() => setInfo(null)); }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Connect an AI client</h2>
        {!info && <div className="muted">Loading…</div>}
        {info && (
          <>
            <Snippet label="Claude Code (run once in any terminal)" value={info.claudeCode} />
            <Snippet label="MCP endpoint (Streamable HTTP)" value={info.mcpUrl} />
            <Snippet label="OpenAPI document" value={info.openapi} />
            <p className="muted small">Claude Desktop and ChatGPT connections arrive with the desktop build.</p>
          </>
        )}
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
