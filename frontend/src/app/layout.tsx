import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Infosys PowerTrader | Energy Market Platform",
  description: "AI-Powered Market Participation & Bid Preparation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[var(--bg-primary)] text-gray-100">
        <div className="flex flex-col h-screen overflow-hidden">
          {/* Infosys top header bar */}
          <header className="infy-header-gradient h-12 flex items-center px-5 shrink-0 z-20 shadow-lg">
            <div className="flex items-center gap-3">
              {/* Infosys wordmark */}
              <div className="flex items-center gap-1.5">
                <svg viewBox="0 0 32 32" className="w-7 h-7 fill-white" aria-hidden="true">
                  <rect width="32" height="32" rx="4" fill="white" fillOpacity="0.15"/>
                  <text x="4" y="23" fontFamily="Arial" fontWeight="bold" fontSize="18" fill="white">i</text>
                  <circle cx="24" cy="10" r="4" fill="#00B398"/>
                </svg>
                <span className="text-white font-bold text-base tracking-wide">Infosys</span>
              </div>
              <span className="text-white/40 text-sm">|</span>
              <span className="text-white/80 text-sm font-medium tracking-wide">PowerTrader</span>
              <span className="ml-2 bg-[#00B398]/20 text-[#00B398] text-[10px] font-semibold px-2 py-0.5 rounded-full border border-[#00B398]/30 uppercase tracking-wider">
                Energy Markets
              </span>
            </div>
            <div className="ml-auto flex items-center gap-4 text-xs text-white/60">
              <span className="hidden sm:block">IEX · DAM · RTM · TAM</span>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-[#00B398] rounded-full animate-pulse"/>
                <span>Live</span>
              </div>
              <span className="hidden md:block text-white/40">
                {/* client-side date rendered in sidebar */}
                CERC 2024 Compliant
              </span>
            </div>
          </header>

          {/* Sidebar + page content */}
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-y-auto p-6 bg-[var(--bg-primary)]">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
