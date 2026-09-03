import { useStore } from '../store';

export function StatusBar() {
  const connection = useStore((s) => s.connection);
  const version = useStore((s) => s.workspace?.version);
  const actor = useStore((s) => s.lastActor);
  const who = actor === 'mcp' ? 'updated by AI' : actor === 'api' ? 'updated via API' : '';
  return (
    <div className="status">
      <span className={`dot ${connection}`} title={connection} />
      <span className="muted small">v{version ?? '-'} {who}</span>
    </div>
  );
}
