import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateActivePeriods,
  calculateBridgeVolume,
  calculateTxCounts,
  calculateTwabUsd,
  calculateVolumeUsd,
} from "@/lib/hevm/metrics";
import { createPriceContext } from "@/lib/hevm/pricing";
import { ClassifiedActivity, PortfolioSegment, RawActivity } from "@/lib/hevm/types";
import { computeStakingTwabFromDelegatorHistory } from "@/lib/dashboard/trading";

test("TWAB simple example equals 350 USD", () => {
  const day = 24 * 60 * 60;
  const segments: PortfolioSegment[] = [
    {
      startTimestamp: 0,
      endTimestamp: 3 * day,
      durationSeconds: 3 * day,
      totalUsd: 100,
      contribution: 100 * 3 * day,
      positions: [],
      priceSources: [],
    },
    {
      startTimestamp: 3 * day,
      endTimestamp: 7 * day,
      durationSeconds: 4 * day,
      totalUsd: 500,
      contribution: 500 * 4 * day,
      positions: [],
      priceSources: [],
    },
    {
      startTimestamp: 7 * day,
      endTimestamp: 10 * day,
      durationSeconds: 3 * day,
      totalUsd: 400,
      contribution: 400 * 3 * day,
      positions: [],
      priceSources: [],
    },
  ];

  const result = calculateTwabUsd(segments);
  assert.equal(result.twabUsd, 350);
});

test("TWAB net HEVM example includes wallet cash, LP exposure, and lending net debt", () => {
  const day = 24 * 60 * 60;
  const segments: PortfolioSegment[] = [
    {
      startTimestamp: 0,
      endTimestamp: 181 * day,
      durationSeconds: 181 * day,
      totalUsd: 600,
      contribution: 600 * 181 * day,
      positions: [],
      priceSources: [],
    },
    {
      startTimestamp: 181 * day,
      endTimestamp: 365 * day,
      durationSeconds: 184 * day,
      totalUsd: 10_100,
      contribution: 10_100 * 184 * day,
      positions: [],
      priceSources: [],
    },
  ];

  const result = calculateTwabUsd(segments);
  assert.equal(Number(result.twabUsd.toFixed(2)), 5389.04);
});

test("tx count breakdown tracks sent/received/erc20/internal/all", () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const activities: RawActivity[] = [
    {
      txHash: "0x01",
      blockNumber: 1,
      timestamp: 1,
      from: wallet,
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      type: "normal_tx",
    },
    {
      txHash: "0x02",
      blockNumber: 2,
      timestamp: 2,
      from: "0xcccccccccccccccccccccccccccccccccccccccc",
      to: wallet,
      type: "normal_tx",
    },
    {
      txHash: "0x03",
      blockNumber: 3,
      timestamp: 3,
      from: "0xcccccccccccccccccccccccccccccccccccccccc",
      to: wallet,
      type: "erc20_transfer",
      logIndex: 1,
    },
    {
      txHash: "0x04",
      blockNumber: 4,
      timestamp: 4,
      from: wallet,
      to: "0xdddddddddddddddddddddddddddddddddddddddd",
      type: "internal_transfer",
      traceId: "0_0",
    },
  ];

  const counts = calculateTxCounts(activities, wallet);
  assert.equal(counts.sentAccountTxCount, 1);
  assert.equal(counts.receivedAccountTxCount, 1);
  assert.equal(counts.erc20TransferCount, 1);
  assert.equal(counts.internalTxCount, 1);
  assert.equal(counts.allActivityTxCount, 4);
});

test("active periods count unique day and unique week", () => {
  const activities: RawActivity[] = [
    {
      txHash: "0x01",
      blockNumber: 1,
      timestamp: Date.UTC(2026, 0, 5, 10, 0, 0) / 1000,
      type: "normal_tx",
    },
    {
      txHash: "0x02",
      blockNumber: 2,
      timestamp: Date.UTC(2026, 0, 5, 18, 0, 0) / 1000,
      type: "erc20_transfer",
    },
    {
      txHash: "0x03",
      blockNumber: 3,
      timestamp: Date.UTC(2026, 0, 14, 10, 0, 0) / 1000,
      type: "internal_transfer",
    },
  ];

  const periods = calculateActivePeriods(activities);
  assert.equal(periods.activeDays, 2);
  assert.equal(periods.activeWeeks, 2);
});

test("bridge volume classifies Core->EVM and EVM->Core", async () => {
  const activities: ClassifiedActivity[] = [
    {
      txHash: "0x01",
      blockNumber: 1,
      timestamp: 1,
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0x2222222222222222222222222222222222222222",
      type: "native_transfer",
      protocolId: "native",
      protocolName: "Native",
      category: "native",
      confidence: 1,
      amount: 1,
    },
    {
      txHash: "0x02",
      blockNumber: 2,
      timestamp: 2,
      from: "0x2222222222222222222222222222222222222222",
      to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      type: "native_transfer",
      protocolId: "native",
      protocolName: "Native",
      category: "native",
      confidence: 1,
      amount: 1,
    },
  ];

  const bridge = await calculateBridgeVolume(activities, async () => 100);
  assert.equal(bridge.evmToCoreVolumeUsd, 100);
  assert.equal(bridge.coreToEvmVolumeUsd, 100);
  assert.equal(bridge.totalBridgeVolumeUsd, 200);
});

test("volume uses source-only tx aggregation and avoids double counting", async () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const activities: ClassifiedActivity[] = [
    {
      txHash: "0xvol-1",
      blockNumber: 1,
      timestamp: 1,
      from: wallet,
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      type: "erc20_transfer",
      protocolId: "erc20",
      protocolName: "ERC20",
      category: "erc20",
      confidence: 1,
      amount: 100,
      direction: "out",
      token: "USDC",
      amountRaw: "100000000",
      logIndex: 1,
    },
    {
      txHash: "0xvol-1",
      blockNumber: 1,
      timestamp: 1,
      from: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      to: wallet,
      type: "erc20_transfer",
      protocolId: "erc20",
      protocolName: "ERC20",
      category: "erc20",
      confidence: 1,
      amount: 99,
      direction: "in",
      token: "XYZ",
      amountRaw: "99000000",
      logIndex: 2,
    },
    {
      txHash: "0xvol-1",
      blockNumber: 1,
      timestamp: 1,
      from: wallet,
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      type: "native_transfer",
      protocolId: "native",
      protocolName: "Native",
      category: "native",
      confidence: 1,
      amount: 3,
      direction: "out",
      token: "HYPE",
      amountRaw: "3000000000000000000",
    },
    {
      txHash: "0xvol-2",
      blockNumber: 2,
      timestamp: 2,
      from: wallet,
      to: "0xcccccccccccccccccccccccccccccccccccccccc",
      type: "native_transfer",
      protocolId: "native",
      protocolName: "Native",
      category: "native",
      confidence: 1,
      amount: 2,
      direction: "out",
      token: "HYPE",
      amountRaw: "2000000000000000000",
    },
  ];

  const result = await calculateVolumeUsd(activities, async (activity) => activity.amount ?? 0);
  assert.equal(result.totalVolumeUsd, 102);
  assert.equal(result.transferVolumeUsd, 102);
  assert.equal(result.bridgeVolumeUsd, 0);
});

test("bridge volume prefers concrete bridge transfers over duplicate bridge_event rows", async () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const system = "0x2222222222222222222222222222222222222222";
  const activities: ClassifiedActivity[] = [
    {
      txHash: "0xbr-1",
      blockNumber: 1,
      timestamp: 1,
      from: wallet,
      to: system,
      type: "erc20_transfer",
      protocolId: "erc20",
      protocolName: "ERC20",
      category: "erc20",
      confidence: 1,
      amount: 50,
      direction: "out",
      token: "USDC",
      amountRaw: "50000000",
      logIndex: 1,
    },
    {
      txHash: "0xbr-1",
      blockNumber: 1,
      timestamp: 1,
      from: wallet,
      to: system,
      type: "bridge_event",
      protocolId: "bridge",
      protocolName: "Bridge",
      category: "bridge",
      confidence: 1,
      amount: 50,
      direction: "out",
      token: "USDC",
      amountRaw: "50000000",
      logIndex: 1,
    },
    {
      txHash: "0xbr-2",
      blockNumber: 2,
      timestamp: 2,
      from: system,
      to: wallet,
      type: "native_transfer",
      protocolId: "native",
      protocolName: "Native",
      category: "native",
      confidence: 1,
      amount: 25,
      direction: "in",
      token: "HYPE",
      amountRaw: "25000000000000000000",
    },
  ];

  const bridge = await calculateBridgeVolume(activities, async (activity) => activity.amount ?? 0);
  assert.equal(bridge.evmToCoreVolumeUsd, 50);
  assert.equal(bridge.coreToEvmVolumeUsd, 25);
  assert.equal(bridge.totalBridgeVolumeUsd, 75);
});

test("bridge detection does not treat random 0x20-prefixed address as system bridge", async () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const random20Prefix = "0x20abcdefabcdefabcdefabcdefabcdefabcdef12";
  const activities: ClassifiedActivity[] = [
    {
      txHash: "0xnb-1",
      blockNumber: 1,
      timestamp: 1,
      from: wallet,
      to: random20Prefix,
      type: "erc20_transfer",
      protocolId: "erc20",
      protocolName: "ERC20",
      category: "erc20",
      confidence: 1,
      amount: 100,
      direction: "out",
      token: "USDC",
      amountRaw: "100000000",
      logIndex: 1,
    },
  ];

  const bridge = await calculateBridgeVolume(activities, async (activity) => activity.amount ?? 0);
  assert.equal(bridge.totalBridgeVolumeUsd, 0);
});

test("unknown token price is ignored and does not crash", async () => {
  const { context, ignoredTokens } = await createPriceContext();
  const price = await context.resolvePriceUsd("SOME_UNKNOWN_TOKEN_123456", Math.floor(Date.now() / 1000));
  assert.equal(price.source, "missing");
  assert.equal(ignoredTokens.length > 0, true);
});

test("staking TWAB applies undelegates forward without inflating historical stake", () => {
  const day = 24 * 60 * 60 * 1000;
  const validator = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const updates = [
    {
      time: day,
      delta: {
        delegate: {
          validator,
          amount: "100",
          isUndelegate: false,
        },
      },
    },
    {
      time: 6 * day,
      delta: {
        delegate: {
          validator,
          amount: "40",
          isUndelegate: true,
        },
      },
    },
  ];

  const twab = computeStakingTwabFromDelegatorHistory(updates, 11 * day, 60);
  assert.equal(twab, 80);
});

test("staking TWAB caps undelegates per validator", () => {
  const day = 24 * 60 * 60 * 1000;
  const updates = [
    {
      time: day,
      delta: {
        delegate: {
          validator: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          amount: "10",
          isUndelegate: false,
        },
      },
    },
    {
      time: 2 * day,
      delta: {
        delegate: {
          validator: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          amount: "10",
          isUndelegate: true,
        },
      },
    },
  ];

  const twab = computeStakingTwabFromDelegatorHistory(updates, 3 * day, 10);
  assert.equal(twab, 10);
});
