export type RawActivity = {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  from?: string;
  to?: string;
  contractAddress?: string;
  type:
    | "normal_tx"
    | "native_transfer"
    | "erc20_transfer"
    | "internal_transfer"
    | "contract_log"
    | "defi_event"
    | "bridge_event";
  token?: string;
  amountRaw?: string;
  amount?: number;
  feeNative?: number;
  direction?: "in" | "out" | "self" | "unknown";
  logIndex?: number;
  traceId?: string;
};

export type Protocol = {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  contracts: string[];
  source: "defillama" | "manual" | "detected";
};

export type PriceResult = {
  token: string;
  timestamp: number;
  priceUsd: number | null;
  source: "defillama" | "stablecoin" | "onchain" | "fallback_current" | "missing";
};

export type Position = {
  protocol: string;
  category: string;
  asset: string;
  amount: number;
  valueUsd: number;
  blockNumber: number;
  timestamp: number;
  source: "wallet_balance" | "lending" | "vault" | "lp" | "staking" | "bridge" | "unknown";
};

export type PortfolioSegment = {
  startTimestamp: number;
  endTimestamp: number;
  durationSeconds: number;
  totalUsd: number;
  contribution: number;
  positions: Position[];
  priceSources: PriceResult[];
};

export type ClassifiedActivity = RawActivity & {
  protocolId: string;
  protocolName: string;
  category: "dex" | "lending" | "vault" | "staking" | "bridge" | "erc20" | "native" | "unknown";
  confidence: number;
};

export type PriceContext = {
  resolvePriceUsd: (token: string, timestamp: number) => Promise<PriceResult>;
};

export interface HevmProtocolAdapter {
  id: string;
  name: string;
  category: "dex" | "lending" | "vault" | "staking" | "bridge" | "erc20" | "native" | "unknown";
  contracts: string[];
  classifyActivity(activity: RawActivity): ClassifiedActivity[];
  getPositions(wallet: string, blockNumber: number): Promise<Position[]>;
  getVolumeUsd(activity: ClassifiedActivity, priceContext: PriceContext): Promise<number>;
}

export type HevmDashboardStats = {
  wallet: string;
  chainId: 999;
  startTime: number;
  endTime: number;

  twabUsd: number;
  twabSegments: PortfolioSegment[];
  currentPortfolioUsd: number;
  currentPositions: Position[];

  volume: {
    totalVolumeUsd: number;
    swapVolumeUsd: number;
    bridgeVolumeUsd: number;
    lendingVolumeUsd: number;
    stakingVolumeUsd: number;
    transferVolumeUsd: number;
    otherContractVolumeUsd: number;
  };

  contracts: {
    directContracts: number;
    touchedContracts: number;
    protocolContracts: number;
    list: string[];
  };

  activePeriods: {
    activeDays: number;
    activeWeeks: number;
    activeMonths: number;
    activeYears: number;
  };

  walletAge: {
    firstSeenTimestamp: number;
    ageSeconds: number;
    ageDays: number;
  };

  bridge: {
    coreToEvmVolumeUsd: number;
    evmToCoreVolumeUsd: number;
    externalBridgeVolumeUsd: number;
    totalBridgeVolumeUsd: number;
  };

  txCounts: {
    sentAccountTxCount: number;
    receivedAccountTxCount: number;
    erc20TransferCount: number;
    internalTxCount: number;
    contractInteractionCount: number;
    allActivityTxCount: number;
  };

  feesPaidUsd: number;

  debug: {
    ignoredTokens: Array<{ token: string; timestamp: number }>;
    unknownContracts: string[];
    unclassifiedActivities: RawActivity[];
    priceErrors: any[];
    dataSourcesUsed: string[];
    confidenceScore: number;
    volumeBreakdownByCategory: Record<string, number>;
    txCountBreakdown: Record<string, number>;
    protocolClassification: Record<string, number>;
  };
};
