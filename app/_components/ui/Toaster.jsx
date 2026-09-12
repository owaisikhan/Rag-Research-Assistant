"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import Icon from "./Icon";

const ToastContext = createContext(() => {});

/**
 * A single place for transient feedback.
 *
 * This exists mainly so that a control which is not built yet FAILS OUT LOUD.
 * A button that looks live and does nothing when clicked is worse than no
 * button: in a demo the viewer assumes the product is broken rather than
 * unfinished. Every placeholder control below calls notify() with what it will
 * eventually do, so the gap reads as a roadmap rather than a bug.
 */
export function Toaster({ children }) {
  const [toasts, setToasts] = useState([]);

  const notify = useCallback((message, { tone = "info", ms = 2600 } = {}) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, ms);
  }, []);

  // Memoised so every consumer does not re-render on each toast.
  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* aria-live so the message reaches a screen reader, which otherwise
          never learns that anything happened. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="toast-in pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-xl border border-border bg-surface-raised px-3.5 py-2.5 text-sm text-ink shadow-lg backdrop-blur"
          >
            <span
              className={
                toast.tone === "success"
                  ? "mt-0.5 text-success"
                  : toast.tone === "danger"
                    ? "mt-0.5 text-danger"
                    : "mt-0.5 text-primary"
              }
            >
              <Icon name={toast.tone === "success" ? "check" : "info"} />
            </span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
