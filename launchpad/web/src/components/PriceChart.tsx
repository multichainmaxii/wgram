"use client";

import { useEffect, useMemo, useRef } from "react";
import { CandlestickSeries, ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Trade } from "@/lib/types";

type Candle = { time: number; open: number; high: number; low: number; close: number };
type Point = { time: number; value: number };
type Series = { kind: "candles"; data: Candle[] } | { kind: "line"; data: Point[] };

// Candles only read as a chart once a few minutes have traded; until then a line
// through every trade says more.
const MIN_CANDLES = 5;

export function PriceChart({ trades, error }: { trades: Trade[] | null; error?: string | null }) {
  const series = useMemo(() => (trades?.length ? toSeries(trades) : null), [trades]);
  return (
    <div className="rounded-2xl border border-line bg-panel p-5">
      <div className="mb-3 flex justify-between text-sm">
        <span className="font-semibold">Price</span>
        {series && <span className="text-muted">{series.kind === "candles" ? "1m candles" : "Each trade"} · wGRAM</span>}
      </div>
      {series && trades ? (
        <Chart key={series.kind} series={series} version={`${trades.length}:${trades[0].signature}`} />
      ) : (
        <div className="grid h-64 place-items-center text-sm text-muted sm:h-80">
          {trades ? "No trades yet. The chart starts with the first buy." : error ? "Couldn't load trades." : "Loading chart…"}
        </div>
      )}
    </div>
  );
}

// Keyed by kind, so switching from line to candles mounts a fresh chart.
function Chart({ series, version }: { series: Series; version: string }) {
  const { kind } = series;
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ chart: IChartApi; series: ISeriesApi<"Candlestick" | "Line"> } | null>(null);
  const shownRef = useRef<string | null>(null);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim() || "#8a99b3";
    const line = token("--color-line");
    const label = { labelBackgroundColor: token("--color-panel-2") };
    const chart = createChart(containerRef.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: token("--color-muted"),
        fontFamily: getComputedStyle(document.body).fontFamily,
      },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: label, horzLine: label },
    });
    const up = token("--color-up");
    const down = token("--color-down");
    const created =
      kind === "candles"
        ? chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false })
        : chart.addSeries(LineSeries, { color: token("--color-accent"), lineWidth: 2, pointMarkersVisible: true });
    apiRef.current = { chart, series: created };
    return () => {
      apiRef.current = null;
      shownRef.current = null;
      chart.remove();
    };
  }, [kind]);

  // Polls hand over a new array every few seconds; only redraw (and refit) when a
  // trade actually landed, so zooming or panning isn't undone.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || shownRef.current === version) return;
    shownRef.current = version;
    // The chart labels timestamps as UTC; shifting them makes the axis read local time.
    const offset = new Date().getTimezoneOffset() * 60;
    api.series.setData(series.data.map((d) => ({ ...d, time: (d.time - offset) as UTCTimestamp })));
    api.series.applyOptions({ priceFormat: priceFormat(series) });
    api.chart.timeScale().fitContent();
  }, [series, version]);

  return <div ref={containerRef} className="h-64 sm:h-80" />;
}

// Oldest first. A candle opens at the previous close: a curve's price only moves on trades.
function toSeries(trades: Trade[]): Series {
  const ordered = [...trades].reverse().sort((a, b) => a.time - b.time);
  const candles: Candle[] = [];
  for (const { time, priceWgram: price } of ordered) {
    const minute = Math.floor(time / 60) * 60;
    const last = candles.at(-1);
    if (last?.time === minute) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    } else {
      const open = last?.close ?? price;
      candles.push({ time: minute, open, high: Math.max(open, price), low: Math.min(open, price), close: price });
    }
  }
  if (candles.length >= MIN_CANDLES) return { kind: "candles", data: candles };

  const points: Point[] = []; // the chart needs unique times, so one point per second
  for (const { time, priceWgram } of ordered) {
    const last = points.at(-1);
    if (last?.time === time) last.value = priceWgram;
    else points.push({ time, value: priceWgram });
  }
  return { kind: "line", data: points };
}

// Prices are millionths of a wGRAM, so the scale shows significant digits and steps
// a thousandth of the top price's order of magnitude.
function priceFormat(series: Series) {
  const top = Math.max(...series.data.map((d) => ("high" in d ? d.high : d.value)));
  const base = 10 ** (3 - Math.floor(Math.log10(top || 1)));
  return { type: "custom" as const, base, minMove: 1 / base, formatter: (price: number) => (price === 0 ? "0" : price.toPrecision(4)) };
}
