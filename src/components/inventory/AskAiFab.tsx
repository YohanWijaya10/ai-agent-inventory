"use client";

export default function AskAiFab({ onClick, label = "Tanya AI" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="fixed bottom-5 right-5 md:bottom-6 md:right-6 z-40 px-4 py-3 rounded-lg bg-brand-600 text-white shadow-lg hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-300 text-sm font-medium"
    >
      {label}
    </button>
  );
}
