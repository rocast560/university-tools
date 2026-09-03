import { useEffect } from 'react';
import { useStore } from '../store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  const show = useStore((s) => s.showToast);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => show(null), 5000); return () => clearTimeout(t); }, [toast, show]);
  if (!toast) return null;
  return <div className="toast" onClick={() => show(null)}>{toast}</div>;
}
