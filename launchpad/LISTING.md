# Listing kit: wGRAM and the launchpad

Everything to submit wGRAM and the launchpad to Jupiter, DexScreener and trading
terminals. Submissions are made by the owner (they need your accounts); this file has the
facts and the texts to paste.

## Facts

| | |
|---|---|
| Token | Wrapped GRAM (`wGRAM`), 9 decimals |
| Solana mint | `B1ZqtPMn2m6rgZCynGPfhWmo41h8xSwb6A2UZsB5GNq8` |
| Backing | 1:1 GRAM held by the `wgram.near` contract on NEAR (HOT Bridge GRAM, token `1117_`), bridged to Solana by Omni Bridge |
| Main market | Meteora DLMM wGRAM/SOL `7DoV9YSeSDiLF6gh97tAToRSpgtWt4VpZZzZ15pq9XRd` |
| Launchpad config (Meteora DBC) | `DpR8qA8iBorfpFMfoZCiC7psB2YVARNT8cspeAJ7AWPL`, every coin on it is paired with wGRAM |
| Website | https://gramfun.vercel.app |
| Source | https://github.com/multichainmaxii/wgram |
| Logo | https://raw.githubusercontent.com/multichainmaxii/wgram/main/launchpad/brand/wgram-logo.png (512×512 PNG; SVG beside it) |

How anyone can check the backing: `ft_total_supply` on `wgram.near` equals
`mt_balance_of({"account_id":"wgram.near","token_id":"1117_"})` on `v2_1.omni.hot.tg`.

wGRAM is independent: not issued or endorsed by Telegram, the TON Foundation, HOT, NEAR,
Omni or Meteora. Say so wherever a form asks about the project.

The mint's on-chain metadata is set by Omni Bridge (its update authority), with name and
symbol but no logo, so the logo has to be added on each platform below.

## 1. Jupiter (verification and logo)

1. Open https://verified.jup.ag/tokens/submit and paste the mint.
2. Choose **Standard** review (free) or Express (paid in JUP; check the current terms first).
3. Connect the project's X account if you have one; it links the mint to it.
4. Once the token page exists in the portal, choose **Update** to set the logo (link above),
   description and socials.

Short description:

> Wrapped GRAM (wGRAM) is GRAM on Solana, backed 1:1 by GRAM held in an immutable NEAR
> contract and bridged by Omni Bridge. It is the quote token of the GramFun launchpad.

Verification weighs liquidity, holders, organic volume and community support ("smart likes"
on the token's Jupiter page), so it gets easier as volume grows.

## 2. DexScreener (logo and links on every wGRAM pair)

DexScreener's "Enhanced Token Info" is a paid order on its marketplace (about $299). It sets
the logo, description and links for the wGRAM mint, which then shows on every COIN/wGRAM pair.
Optional; Jupiter's logo already reaches many wallets.

## 3. Trading terminals (Axiom, GMGN, Photon, BullX, Trojan…)

Terminals show new launches from launchpads they know, keyed by the Meteora config. Message
for their support or partnerships channel:

> Hi! We run GramFun (https://gramfun.vercel.app), a launchpad on Meteora's Dynamic Bonding
> Curve where every coin is paired with wGRAM, GRAM bridged 1:1 to Solana.
>
> - Launchpad config (DBC): `DpR8qA8iBorfpFMfoZCiC7psB2YVARNT8cspeAJ7AWPL`
> - Quote token: wGRAM `B1ZqtPMn2m6rgZCynGPfhWmo41h8xSwb6A2UZsB5GNq8` (9 decimals)
> - SOL route: Meteora DLMM wGRAM/SOL `7DoV9YSeSDiLF6gh97tAToRSpgtWt4VpZZzZ15pq9XRd`, kept at
>   the GRAM price by a market maker
> - Graduated coins migrate to Meteora DAMM v2 (COIN/wGRAM, liquidity locked)
> - Logo: https://raw.githubusercontent.com/multichainmaxii/wgram/main/launchpad/brand/wgram-logo.png
> - Open source: https://github.com/multichainmaxii/wgram
>
> Could you add the config as a launchpad (label "GramFun") and support buying with SOL via
> the wGRAM/SOL pool? Happy to provide anything else you need.
