export default function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={'toast toast--' + toast.kind} role="status">
      {toast.message}
    </div>
  );
}
