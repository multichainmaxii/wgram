// Launchpad economics, shared by the smoke test, the local seed and the mainnet
// config script, so every environment runs the same curve.
//
// Everything is priced in wGRAM (about $1.51 each when these were chosen).

import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

export const INITIAL_MCAP_WGRAM = 3_000 // ~$4.5k at launch
export const MIGRATION_MCAP_WGRAM = 26_500 // ~$40k, StonkFun's graduation level
export const TRADING_FEE_BPS = 100 // 1%
export const CREATOR_FEE_SHARE_PCT = 50 // creators get half the trading fees
export const LAUNCH_FEE_SOL = 0.01
export const TOTAL_SUPPLY = 1_000_000_000
export const WGRAM_DECIMALS = 9
// Graduated pools use DAMM v2's 1% fee tier.
export const GRADUATED_POOL_FEE_OPTION = MigrationFeeOption.FixedBps100

export function launchpadCurve(): ConfigParameters {
  return buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: WGRAM_DECIMALS,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: TOTAL_SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: TRADING_FEE_BPS, endingFeeBps: TRADING_FEE_BPS, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken, // fees accrue in wGRAM
      creatorTradingFeePercentage: CREATOR_FEE_SHARE_PCT,
      poolCreationFee: LAUNCH_FEE_SOL,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: GRADUATED_POOL_FEE_OPTION,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      // Graduated liquidity is locked forever, split between platform and creator.
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    initialMarketCap: INITIAL_MCAP_WGRAM,
    migrationMarketCap: MIGRATION_MCAP_WGRAM,
  })
}
