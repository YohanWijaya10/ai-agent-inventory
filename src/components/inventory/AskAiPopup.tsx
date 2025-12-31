"use client";

import AskAiMiniChat from './AskAiMiniChat';

type SlimItem = {
  sku: string;
  name: string;
  qtyOnHand: number;
  safetyStock: number;
  reorderPoint: number;
  outQty_7: number;
  outQty_14: number;
  outQty_30: number;
  avgDailyOut: number;
  daysLeft: number | null;
};

export default function AskAiPopup(props: {
  open: boolean;
  onClose: () => void;
  windowDays: 7 | 14 | 30;
  warehouseName: string | null;
  lowStockTop: SlimItem[];
  overStockTop: SlimItem[];
  selectedItem: SlimItem | null;
  onPickSku?: (sku: string) => void;
}) {
  const { open, onClose, onPickSku, ...ctx } = props;
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="relative bg-white rounded-lg shadow-xl w-full max-w-lg">
          <button aria-label="Tutup" onClick={onClose} className="absolute top-3 right-3 text-gray-500 hover:text-gray-700">✕</button>
          <div className="p-4 border-b">
            <div className="text-lg font-semibold">Tanya AI</div>
            <div className="text-xs text-gray-500">Jawaban hanya berdasarkan data dashboard ini.</div>
          </div>
          <div className="p-4">
            <AskAiMiniChat {...ctx} onPickSku={onPickSku} />
          </div>
        </div>
      </div>
    </div>
  );
}
