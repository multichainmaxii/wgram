// The console chrome around every page: a thin left rail with a crosshair, and a boot
// screen on the first visit of a session.

export function LeftRail() {
  return (
    <aside aria-hidden className="pointer-events-none fixed inset-y-0 left-0 z-20 hidden w-11 border-r border-line md:block">
      <svg viewBox="0 0 24 24" className="absolute top-1/2 left-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-text" fill="currentColor">
        <path d="M12 0 L13.2 10.8 L24 12 L13.2 13.2 L12 24 L10.8 13.2 L0 12 L10.8 10.8 Z" />
      </svg>
      <span className="hud absolute bottom-4 left-1/2 -translate-x-1/2 text-[9px] text-muted [writing-mode:vertical-rl]">ONGRAM.FUN // SOL</span>
    </aside>
  );
}

// Runs in <head> before the first paint: after the boot screen's first showing in a
// session it sets html[data-booted], which hides it.
export const BOOT_SCRIPT = `(function(){var d=document.documentElement;try{if(sessionStorage.getItem("booted"))d.setAttribute("data-booted","");sessionStorage.setItem("booted","1")}catch(e){}})()`;

// Plays once per session (see BOOT_SCRIPT), and never for people who prefer reduced motion.
export function BootScreen() {
  return (
    <div aria-hidden className="boot fixed inset-0 z-50 flex items-center justify-center bg-ink [animation:fade-out_.35s_ease_1.5s_forwards]">
      <div className="w-[min(560px,86vw)]">
        <div className="hud text-muted">{"// initializing"}</div>
        <div className="mt-8 h-px w-full bg-line">
          <div className="h-px w-full origin-left bg-text [animation:boot-bar_1.3s_cubic-bezier(.6,0,.2,1)_forwards]" />
        </div>
        <div className="hud mt-2 flex justify-between gap-4 text-[10px] text-muted">
          <span>▶▶ loading</span>
          <span className="truncate">https://ongram.fun/solana/wgram/curve/graduation/</span>
        </div>
      </div>
    </div>
  );
}
