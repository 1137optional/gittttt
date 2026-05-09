import { useApp } from '../store';

export function ToastStack(): JSX.Element {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          onClick={() => dismiss(t.id)}
          title="Click to dismiss"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
