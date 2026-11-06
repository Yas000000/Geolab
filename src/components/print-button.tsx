"use client";

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-full bg-[#EC1912] px-5 py-2 text-sm font-medium text-white shadow hover:bg-[#c81510]"
    >
      Save as PDF
    </button>
  );
}
