"use client";

import Link from "next/link";

const steps = [
  {
    num: 1,
    title: "Forecast",
    desc: "AI generates 96-block price predictions with confidence intervals",
    href: "/forecast",
    color: "blue",
  },
  {
    num: 2,
    title: "Bid Workspace",
    desc: "Review AI recommendations, adjust bids, enforce constraints",
    href: "/bids",
    color: "emerald",
  },
  {
    num: 3,
    title: "Risk Panel",
    desc: "VaR analysis, DSM penalty estimates, real-time alerts",
    href: "/risk",
    color: "amber",
  },
  {
    num: 4,
    title: "Post-Market",
    desc: "Compare predictions vs actuals, track hit rates & basket rates",
    href: "/analysis",
    color: "purple",
  },
];

const colorMap: Record<string, string> = {
  blue: "from-blue-600 to-blue-800 border-blue-500/30",
  emerald: "from-emerald-600 to-emerald-800 border-emerald-500/30",
  amber: "from-amber-600 to-amber-800 border-amber-500/30",
  purple: "from-purple-600 to-purple-800 border-purple-500/30",
};

const textColorMap: Record<string, string> = {
  blue: "text-blue-400",
  emerald: "text-emerald-400",
  amber: "text-amber-400",
  purple: "text-purple-400",
};

export default function Home() {
  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-10">
        <h1 className="text-3xl font-bold mb-2">Power Trading Platform</h1>
        <p className="text-gray-400">
          AI-Powered Market Participation &amp; Bid Preparation for Indian Power
          Markets
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
        {steps.map((step) => (
          <Link key={step.href} href={step.href}>
            <div
              className={`card hover:scale-[1.02] transition-transform cursor-pointer border ${colorMap[step.color]}`}
            >
              <div className="flex items-start gap-4">
                <div
                  className={`w-10 h-10 rounded-lg bg-gradient-to-br ${colorMap[step.color]} flex items-center justify-center text-white font-bold shrink-0`}
                >
                  {step.num}
                </div>
                <div>
                  <h3
                    className={`font-semibold text-lg ${textColorMap[step.color]}`}
                  >
                    {step.title}
                  </h3>
                  <p className="text-gray-400 text-sm mt-1">{step.desc}</p>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold mb-3">Market Segments</h2>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-gray-800/50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-blue-400">DAM</div>
            <div className="text-xs text-gray-400 mt-1">Day-Ahead Market</div>
            <div className="text-xs text-gray-500 mt-2">96 blocks · Gate closure D-1</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-emerald-400">RTM</div>
            <div className="text-xs text-gray-400 mt-1">Real-Time Market</div>
            <div className="text-xs text-gray-500 mt-2">96 blocks · Gate closure 55 min</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-amber-400">TAM</div>
            <div className="text-xs text-gray-400 mt-1">Term-Ahead Market</div>
            <div className="text-xs text-gray-500 mt-2">Intraday · Weekly · Monthly</div>
          </div>
        </div>
      </div>
    </div>
  );
}
