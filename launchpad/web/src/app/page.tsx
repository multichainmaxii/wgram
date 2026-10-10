import Link from "next/link";
import { CoinCount, CoinFan, FeaturedCoin, HeroCoins } from "@/components/home";
import { HERO_ART } from "@/lib/config";

const chamfer = { clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)" };

// The logo's progress ring, drawn big as the hero's centrepiece until real artwork lands.
function RingArt() {
  return (
    <svg viewBox="0 0 512 512" aria-hidden className="absolute top-1/2 right-[-12%] h-[min(92vh,78vw)] -translate-y-1/2 opacity-90 md:right-[-4%]">
      <defs>
        <linearGradient id="hero-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5EE0FF" />
          <stop offset="1" stopColor="#1668D2" />
        </linearGradient>
        <radialGradient id="hero-glow">
          <stop offset="0" stopColor="#2AABEE" stopOpacity=".45" />
          <stop offset="1" stopColor="#2AABEE" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="256" cy="256" r="250" fill="url(#hero-glow)" />
      <circle cx="256" cy="256" r="150" fill="none" stroke="currentColor" strokeOpacity=".08" strokeWidth="44" className="text-text" />
      <path d="M256 106 A150 150 0 1 1 106 256" fill="none" stroke="url(#hero-ring)" strokeWidth="44" strokeLinecap="round" />
      <g transform="translate(256 262) scale(0.5) translate(-256 -285)">
        <polygon points="176,150 336,150 416,210 256,420 96,210" fill="#2A9EF4" stroke="#2A9EF4" strokeWidth="6" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

const LINES = [
  { tag: "01L", word: "Launch." },
  { tag: "02P", word: "Pump." },
  { tag: "03G", word: "Graduate." },
];

const STEPS = [
  { n: "01", title: "Launch", body: "Name, ticker, picture. About 0.035 SOL, no presale, no team allocation. It trades from the first second." },
  { n: "02", title: "Trade", body: "Priced by a bonding curve against wGRAM. Telegram trading bots buy and sell it with SOL." },
  { n: "03", title: "Graduate", body: "At about $40k the curve fills and the coin moves to Meteora, liquidity locked forever." },
  { n: "04", title: "Earn", body: "About 0.4% of every trade is yours, plus half the graduated pool's locked liquidity." },
];

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="grid-lines relative isolate min-h-[calc(100svh-56px)] overflow-hidden border-b border-line">
        {HERO_ART ? (
          // eslint-disable-next-line @next/next/no-img-element -- full-bleed art, already sized
          <img src={HERO_ART} alt="" className="absolute inset-0 -z-10 size-full object-cover" />
        ) : (
          <RingArt />
        )}
        <HeroCoins />
        <p className="relative max-w-[280px] px-4 pt-8 text-sm leading-relaxed md:px-6">
          ongram.fun is a launchpad for coins paired with GRAM, Telegram&apos;s coin, on Solana. Launch one in a minute and watch it climb
          its curve to graduation.
        </p>
        <div className="hud absolute top-8 right-4 hidden text-right text-muted sm:block md:right-6">
          {"// live coins"}
          <div className="display mt-1 text-3xl text-text">
            <CoinCount />
          </div>
        </div>
        <h1 className="absolute right-4 bottom-14 left-4 md:right-6 md:left-6">
          {LINES.map((l, i) => (
            <span key={l.tag} className={`relative block ${i === 1 ? "sm:pl-[14vw]" : i === 2 ? "sm:pl-[4vw]" : ""}`}>
              <span className="hud absolute -top-1 text-[10px] text-muted">{l.tag}</span>
              <span className="display block text-[14.5vw] sm:text-[12.5vw] xl:text-[11vw]">{l.word}</span>
            </span>
          ))}
        </h1>
        <div className="hud absolute bottom-4 left-4 text-muted md:left-6">{"© ongram.fun // solana"}</div>
        <a href="#story" className="hud absolute right-4 bottom-4 text-muted hover:text-text md:right-6">
          Scroll ↓
        </a>
      </section>

      {/* Story */}
      <section id="story" className="grid scroll-mt-14 gap-10 border-b border-line px-4 py-20 md:grid-cols-[1.3fr_1fr] md:px-6">
        <div>
          <div className="hud text-muted">{"// 001"}</div>
          <h2 className="display mt-4 text-5xl sm:text-6xl lg:text-7xl">A familiar coin… on a different chain.</h2>
          <p className="mt-8 max-w-md text-muted">
            GRAM is Telegram&apos;s coin. Here it lives on Solana as <b className="text-text">wGRAM</b>, backed one to one by real GRAM, and every coin
            launched here is paired with it.
          </p>
          <Link href="/explore" style={chamfer} className="hud mt-8 inline-flex h-11 items-center bg-text px-6 text-ink hover:opacity-85">
            Explore coins
          </Link>
        </div>
        <div className="mx-auto w-full max-w-sm">
          <div className="hud mb-3 text-muted">{"// top coin right now"}</div>
          <FeaturedCoin />
        </div>
      </section>

      {/* Graduation */}
      <section className="relative overflow-hidden bg-[#2AABEE] px-4 py-20 text-[#0B1520] md:px-6">
        <div className="grid items-center gap-10 md:grid-cols-[auto_1fr]">
          <div aria-hidden className="display text-[34vw] leading-[0.75] md:text-[22vw]">
            40K
          </div>
          <div>
            <div className="hud opacity-70">{"// 002 · graduation"}</div>
            <h2 className="display mt-4 text-4xl sm:text-5xl">Every coin graduates at $40K.</h2>
            <p className="mt-6 max-w-md">
              When a coin&apos;s curve fills, its liquidity moves into a Meteora pool against wGRAM and is locked forever. Half of it belongs to the creator.
            </p>
            <div className="hud mt-8 grid max-w-md grid-cols-3 gap-px border border-[#0B1520]/25 bg-[#0B1520]/25">
              {[
                ["1.5%", "trading fee"],
                ["0.4%", "to the creator"],
                ["1B", "supply"],
              ].map(([v, k]) => (
                <div key={k} className="bg-[#2AABEE] p-3">
                  <div className="display text-2xl">{v}</div>
                  <div className="mt-1 opacity-70">{k}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Live coins */}
      <section className="overflow-hidden border-b border-line px-4 py-20 md:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="hud text-muted">{"// 003"}</div>
            <h2 className="display mt-4 text-5xl sm:text-6xl">Live coins.</h2>
          </div>
          <Link href="/explore" className="hud text-muted hover:text-text">
            Explore all →
          </Link>
        </div>
        <div className="mt-12">
          <CoinFan />
        </div>
      </section>

      {/* Creator */}
      <section className="px-4 py-20 md:px-6">
        <div className="hud text-muted">{"// 004"}</div>
        <div className="mt-6 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n} className="bg-ink p-6">
              <div className="display text-5xl text-accent">{s.n}</div>
              <div className="display mt-6 text-2xl">{s.title}</div>
              <p className="mt-3 text-sm text-muted">{s.body}</p>
            </div>
          ))}
        </div>
        <Link href="/launch" style={chamfer} className="hud mt-10 inline-flex h-12 items-center bg-accent px-8 text-ink hover:bg-accent-strong">
          Launch a coin
        </Link>
      </section>
    </>
  );
}
