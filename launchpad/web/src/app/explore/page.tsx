import type { Metadata } from "next";
import { CoinList } from "@/components/CoinList";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = { title: `Explore · ${BRAND.name}` };

export default function ExplorePage() {
  return (
    <div className="px-4 py-10 md:px-6">
      <div className="hud text-muted">{"// explore"}</div>
      <h1 className="display mt-3 text-[15vw] sm:text-8xl">Explore</h1>
      <p className="mt-4 max-w-lg text-muted">Every coin launched here, all paired with wGRAM. Tap one to trade it.</p>
      <div className="mt-10">
        <CoinList />
      </div>
    </div>
  );
}
