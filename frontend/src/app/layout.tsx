import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "PowerTrader | Energy Market Platform",
  description: "AI-Powered Market Participation & Bid Preparation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[var(--bg-primary)] text-gray-900">
        <div className="flex flex-col h-screen overflow-hidden">
          {/* Top header bar */}
          <header className="header-gradient h-12 flex items-center px-5 shrink-0 z-20 shadow-lg">
            <div className="flex items-center gap-3">
              <span className="text-white text-sm font-semibold tracking-wide">PowerTrader</span>
            </div>
            <div className="ml-auto flex items-center gap-4 text-xs text-white/60">
              <span className="hidden sm:block">IEX · DAM · RTM · TAM</span>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-[#00B398] rounded-full animate-pulse"/>
                <span>Live</span>
              </div>
              <span className="hidden md:block text-white/40">
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
